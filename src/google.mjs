import { createPrivateKey, sign, constants } from 'node:crypto';
import {
  assertIsoDate, dateInTimeZone, shiftDate, daysBetween, datesInPeriod,
  comparisonPeriods, compareTotals, buildMovers,
} from './metrics.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GSC_TIME_ZONE = 'America/Los_Angeles';
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const GSC_METRICS = ['clicks', 'impressions', 'ctr', 'position'];
const GA4_METRICS = { sessions: 'sessions', activeUsers: 'active_users', keyEvents: 'key_events' };
const WINDOW_LENGTHS = [7, 28];

/** Deliberately contains no provider response, request, credential, or error cause. */
export class GoogleCollectionError extends Error {
  constructor(code, sourceId, httpStatus) {
    super(code);
    this.name = 'GoogleCollectionError';
    this.code = code;
    this.source_id = sourceId;
    if (httpStatus !== undefined) this.http_status = httpStatus;
  }

  toJSON() {
    return {
      code: this.code, source_id: this.source_id,
      ...(this.http_status === undefined ? {} : { http_status: this.http_status }),
    };
  }
}

function fail(code, sourceId, status) {
  throw new GoogleCollectionError(code, sourceId, status);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeDate(value, sourceId) {
  try { return assertIsoDate(value); } catch { fail(`${sourceId.toUpperCase()}_INVALID_RESPONSE`, sourceId); }
}

function numberValue(value, sourceId, { maximum = Infinity, integer = false } = {}) {
  if (typeof value !== 'number' &&
      !(typeof value === 'string' && /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))) {
    fail(`${sourceId.toUpperCase()}_INVALID_RESPONSE`, sourceId);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > maximum ||
      (integer && !Number.isSafeInteger(number))) {
    fail(`${sourceId.toUpperCase()}_INVALID_RESPONSE`, sourceId);
  }
  return number;
}

function readCredentials(env) {
  if (typeof env.GOOGLE_CREDENTIALS_JSON !== 'string' || !env.GOOGLE_CREDENTIALS_JSON.trim()) {
    fail('GOOGLE_CREDENTIALS_INVALID', 'gsc');
  }
  let credentials;
  try { credentials = JSON.parse(env.GOOGLE_CREDENTIALS_JSON); } catch {
    fail('GOOGLE_CREDENTIALS_INVALID', 'gsc');
  }
  if (!isObject(credentials) ||
      (credentials.token_uri !== undefined && credentials.token_uri !== TOKEN_URL)) {
    fail('GOOGLE_CREDENTIALS_INVALID', 'gsc');
  }
  const nonempty = (name) => typeof credentials[name] === 'string' && credentials[name].trim().length > 0;
  if (credentials.type === 'authorized_user') {
    if (!['client_id', 'client_secret', 'refresh_token'].every(nonempty)) {
      fail('GOOGLE_CREDENTIALS_INVALID', 'gsc');
    }
    return credentials;
  }
  if (credentials.type === 'service_account' && nonempty('client_email') && nonempty('private_key')) {
    try {
      const key = createPrivateKey(credentials.private_key);
      if (key.asymmetricKeyType !== 'rsa') fail('GOOGLE_CREDENTIALS_INVALID', 'gsc');
      return { ...credentials, signing_key: key };
    } catch { fail('GOOGLE_CREDENTIALS_INVALID', 'gsc'); }
  }
  fail('GOOGLE_CREDENTIALS_INVALID', 'gsc');
}

function validatedOptions(config, now, asOf) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('GOOGLE_DATE_INVALID', 'gsc');
  const gsc = config?.gsc;
  if (!isObject(gsc) || typeof gsc.property !== 'string' || !gsc.property.trim()) {
    fail('GSC_PROPERTY_REQUIRED', 'gsc');
  }
  const property = gsc.property.trim();
  let propertyValid = /^sc-domain:[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(property);
  if (!propertyValid) {
    try {
      const url = new URL(property);
      propertyValid = ['https:', 'http:'].includes(url.protocol) && Boolean(url.hostname) &&
        !url.username && !url.password && !url.hash;
    } catch { /* Fixed error below. */ }
  }
  if (!propertyValid) fail('GSC_PROPERTY_INVALID', 'gsc');
  const searchType = gsc.search_type ?? 'web';
  if (!['web', 'image', 'video', 'news'].includes(searchType)) fail('GSC_SEARCH_TYPE_INVALID', 'gsc');
  const historyDays = gsc.history_days ?? 90;
  const detailLimit = gsc.detail_limit ?? 2500;
  if (!Number.isInteger(historyDays) || historyDays < 56 || historyDays > 450) {
    fail('GSC_HISTORY_DAYS_INVALID', 'gsc');
  }
  if (!Number.isInteger(detailLimit) || detailLimit < 1 || detailLimit > 50000) {
    fail('GSC_DETAIL_LIMIT_INVALID', 'gsc');
  }
  const sourceToday = dateInTimeZone(now, GSC_TIME_ZONE);
  if (asOf !== undefined && asOf !== null) {
    try { assertIsoDate(asOf); } catch { fail('GSC_AS_OF_INVALID', 'gsc'); }
    if (asOf >= sourceToday) fail('GSC_AS_OF_NOT_FINAL', 'gsc');
  }
  const ga4Raw = config?.ga4?.property_id;
  const ga4Configured = ga4Raw !== null && ga4Raw !== undefined && ga4Raw !== '';
  const ga4Property = ga4Configured ? String(ga4Raw).replace(/^properties\//, '') : null;
  const ga4Hostname = config?.ga4?.hostname ?? null;
  return { property, searchType, historyDays, detailLimit, sourceToday, asOf, ga4Configured, ga4Property, ga4Hostname };
}

function createGoogleClient(credentials, scopes, fetchImpl, now) {
  let token;
  let expiresAt = 0;
  const wallStart = Date.now();
  const clock = () => now.getTime() + Date.now() - wallStart;
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function requestJson(url, options, sourceId, prefix) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000), redirect: 'error' });
      } catch {
        if (attempt < 2) { await wait(100 * 2 ** attempt); continue; }
        fail(`${prefix}_NETWORK_ERROR`, sourceId);
      }
      if (!response || !Number.isInteger(response.status)) fail(`${prefix}_INVALID_RESPONSE`, sourceId);
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        if (attempt < 2) {
          const header = response.headers?.get?.('retry-after');
          const delay = header !== null && header !== undefined && /^\d+(?:\.\d+)?$/.test(header)
            ? Math.min(Number(header) * 1000, 2000) : 100 * 2 ** attempt;
          try { await response.body?.cancel(); } catch { /* No provider body is retained. */ }
          await wait(delay);
          continue;
        }
      }
      if (response.status < 200 || response.status >= 300) {
        try { await response.body?.cancel(); } catch { /* Never read error bodies. */ }
        fail(`${prefix}_HTTP_ERROR`, sourceId, response.status);
      }
      let data;
      try {
        const text = await response.text();
        if (text.length > 32 * 1024 * 1024) fail(`${prefix}_INVALID_RESPONSE`, sourceId);
        data = JSON.parse(text);
      } catch { fail(`${prefix}_INVALID_RESPONSE`, sourceId); }
      if (!isObject(data) || data.error !== undefined) fail(`${prefix}_INVALID_RESPONSE`, sourceId);
      return data;
    }
    fail(`${prefix}_NETWORK_ERROR`, sourceId);
  }

  async function getToken(sourceId, force = false) {
    if (!force && token && clock() < expiresAt - 60000) return token;
    let form;
    if (credentials.type === 'authorized_user') {
      form = new URLSearchParams({
        grant_type: 'refresh_token', client_id: credentials.client_id,
        client_secret: credentials.client_secret, refresh_token: credentials.refresh_token,
      });
    } else {
      const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const issuedAt = Math.floor(clock() / 1000);
      const payload = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({
        iss: credentials.client_email, scope: scopes.join(' '), aud: TOKEN_URL,
        iat: issuedAt, exp: issuedAt + 3600,
      })}`;
      let signature;
      try {
        signature = sign('RSA-SHA256', Buffer.from(payload), {
          key: credentials.signing_key, padding: constants.RSA_PKCS1_PADDING,
        }).toString('base64url');
      } catch { fail('GOOGLE_CREDENTIALS_INVALID', sourceId); }
      form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${payload}.${signature}`,
      });
    }
    const result = await requestJson(TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    }, sourceId, 'GOOGLE_AUTH');
    if (typeof result.access_token !== 'string' || !result.access_token.trim()) {
      fail('GOOGLE_AUTH_INVALID_RESPONSE', sourceId);
    }
    const expiresIn = Number(result.expires_in ?? 3600);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) fail('GOOGLE_AUTH_INVALID_RESPONSE', sourceId);
    token = result.access_token;
    expiresAt = clock() + expiresIn * 1000;
    return token;
  }

  return {
    async post(url, body, sourceId) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const accessToken = await getToken(sourceId, attempt === 1);
        try {
          return await requestJson(url, {
            method: 'POST', headers: {
              authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
            }, body: JSON.stringify(body),
          }, sourceId, sourceId.toUpperCase());
        } catch (error) {
          if (error instanceof GoogleCollectionError && error.http_status === 401 && attempt === 0) continue;
          throw error;
        }
      }
      fail('GOOGLE_AUTH_FAILED', sourceId);
    },
  };
}

function gscRows(response, dimension, period) {
  const rows = response.rows ?? [];
  if (!Array.isArray(rows)) fail('GSC_INVALID_RESPONSE', 'gsc');
  const seen = new Set();
  return rows.map((row) => {
    if (!isObject(row)) fail('GSC_INVALID_RESPONSE', 'gsc');
    const metrics = Object.fromEntries(GSC_METRICS.map((name) => [
      name, numberValue(row[name], 'gsc', name === 'ctr' ? { maximum: 1 } : {}),
    ]));
    if (metrics.impressions === 0) {
      // Google may encode undefined rates/ranks as zero on an observed empty row.
      metrics.ctr = null;
      metrics.position = null;
    }
    if (!dimension) {
      if (rows.length > 1 || (row.keys !== undefined && (!Array.isArray(row.keys) || row.keys.length !== 0))) {
        fail('GSC_INVALID_RESPONSE', 'gsc');
      }
      return metrics;
    }
    if (!Array.isArray(row.keys) || row.keys.length !== 1 || typeof row.keys[0] !== 'string') {
      fail('GSC_INVALID_RESPONSE', 'gsc');
    }
    const key = row.keys[0];
    if (seen.has(key)) fail('GSC_INVALID_RESPONSE', 'gsc');
    seen.add(key);
    if (dimension === 'date') {
      safeDate(key, 'gsc');
      if (key < period.start_date || key > period.end_date) fail('GSC_INVALID_RESPONSE', 'gsc');
      return { date: key, ...metrics };
    }
    return { key, ...metrics };
  });
}

async function collectGsc(client, options, collectedAt) {
  const { property, searchType, historyDays, detailLimit, sourceToday, asOf } = options;
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const evidenceUrl = `https://search.google.com/search-console?resource_id=${encodeURIComponent(property)}`;
  const evidence = [];
  const notes = [
    'GSC_DATES_USE_AMERICA_LOS_ANGELES',
    'GSC_DETAIL_ROWS_ARE_NOT_EXHAUSTIVE',
    'MISSING_DETAIL_ROWS_ARE_NOT_ZERO',
    'RATES_ARE_FRACTIONS_AND_RELATIVE_CHANGES_ARE_RATIOS',
  ];
  if (property.startsWith('sc-domain:')) {
    notes.push(`GSC 使用 Domain property，范围包括 ${property.slice('sc-domain:'.length)} 的所有子域与协议，并非仅 www 主站。`);
  }
  const evidenceFor = (id, title, details) => {
    evidence.push({ id, source_id: 'gsc', title, observed_at: collectedAt, url: evidenceUrl, details });
    return id;
  };
  const query = async (period, dimension, { state = 'final', limit = 1000, startRow = 0 } = {}) => {
    const body = {
      startDate: period.start_date, endDate: period.end_date,
      dimensions: dimension ? [dimension] : [], type: searchType, dataState: state,
      aggregationType: dimension === 'page' ? 'auto' : 'byProperty',
      rowLimit: limit, startRow,
    };
    const response = await client.post(endpoint, body, 'gsc');
    if (response.responseAggregationType !== undefined &&
        response.responseAggregationType !== (dimension === 'page' ? 'byPage' : 'byProperty')) {
      fail('GSC_AGGREGATION_MISMATCH', 'gsc');
    }
    return response;
  };
  const probePeriod = { start_date: shiftDate(sourceToday, -14), end_date: sourceToday };
  const allProbe = await query(probePeriod, 'date', { state: 'all' });
  gscRows(allProbe, 'date', probePeriod);
  const finalProbePeriod = { ...probePeriod, end_date: shiftDate(sourceToday, -1) };
  const finalProbe = await query(finalProbePeriod, 'date');
  const finalDates = gscRows(finalProbe, 'date', finalProbePeriod).map((row) => row.date).sort();
  const latestFinalObserved = finalDates.at(-1) ?? null;
  if (!latestFinalObserved) fail('GSC_NO_FINAL_DATA', 'gsc');
  let firstIncomplete = allProbe.metadata?.first_incomplete_date ?? null;
  if (firstIncomplete !== null) {
    firstIncomplete = safeDate(firstIncomplete, 'gsc');
    if (firstIncomplete > sourceToday) fail('GSC_INVALID_RESPONSE', 'gsc');
  }
  const finalBoundary = firstIncomplete
    ? [shiftDate(firstIncomplete, -1), shiftDate(sourceToday, -1)].sort()[0]
    : latestFinalObserved;
  if (asOf && asOf > finalBoundary) fail('GSC_AS_OF_NOT_FINAL', 'gsc');
  const conservativeEnd = shiftDate(sourceToday, -3);
  const endDate = asOf ?? [finalBoundary, conservativeEnd].sort()[0];
  const cutoff = {
    method: firstIncomplete ? 'first_incomplete_date_and_final_probe' : 'latest_observed_final_date',
    requested_as_of: asOf ?? null,
    first_incomplete_date: firstIncomplete,
    verified_final_boundary: finalBoundary,
    latest_observed_final_date: latestFinalObserved,
    default_lag_days: 3,
    lag_days: daysBetween(endDate, sourceToday),
    probe_period: probePeriod,
  };
  evidenceFor('gsc_cutoff', 'GSC finalized data cutoff', cutoff);
  const dailyPeriod = { start_date: shiftDate(endDate, 1 - historyDays), end_date: endDate };
  const dailyResponse = await query(dailyPeriod, 'date');
  const daily = gscRows(dailyResponse, 'date', dailyPeriod).sort((a, b) => a.date.localeCompare(b.date));
  if (!daily.length) fail('GSC_NO_FINAL_DATA', 'gsc');
  const observedDays = new Set(daily.map((row) => row.date));
  const missingDates = datesInPeriod(dailyPeriod.start_date, dailyPeriod.end_date).filter((date) => !observedDays.has(date));
  let partial = false;
  if (!observedDays.has(endDate)) { notes.push('GSC_CUTOFF_DATE_NOT_OBSERVED'); partial = true; }
  if (!asOf && cutoff.lag_days > 3) { notes.push('GSC_FINAL_DATA_LAG'); partial = true; }
  if (missingDates.length) notes.push('GSC_MISSING_DAILY_DATES_ARE_NOT_FILLED_WITH_ZERO');
  evidenceFor('gsc_daily', 'GSC daily property totals', {
    ...dailyPeriod, dimensions: ['date'], data_state: 'final', returned_rows: daily.length,
    response_aggregation_type: dailyResponse.responseAggregationType ?? null,
    missing_dates: missingDates,
  });
  const coverage = {
    property, search_type: searchType, data_state: 'final', cutoff,
    totals_source: 'independent_dimensionless_query', totals_complete: true,
    daily: { ...dailyPeriod, returned_rows: daily.length, missing_dates: missingDates, missing_dates_are_zero: false },
    details: {},
  };
  const comparisons = {};
  const movers = {};

  async function detailRows(period, dimension, evidenceId) {
    const rows = [];
    let exhausted = false;
    let responseAggregation = null;
    while (rows.length < detailLimit) {
      const requestLimit = Math.min(25000, detailLimit - rows.length);
      const response = await query(period, dimension, { limit: requestLimit, startRow: rows.length });
      const page = gscRows(response, dimension, period);
      if (page.length > requestLimit) fail('GSC_INVALID_RESPONSE', 'gsc');
      rows.push(...page);
      responseAggregation = response.responseAggregationType ?? responseAggregation;
      if (page.length < requestLimit) { exhausted = true; break; }
    }
    if (new Set(rows.map((row) => row.key)).size !== rows.length) fail('GSC_INVALID_RESPONSE', 'gsc');
    const info = {
      coverage: 'observed_top_rows', returned_rows: rows.length, requested_limit: detailLimit,
      pagination_exhausted: exhausted, at_requested_limit: rows.length === detailLimit,
      exhaustive: false, response_aggregation_type: responseAggregation,
    };
    evidenceFor(evidenceId, `GSC observed ${dimension} rows`, {
      ...period, dimensions: [dimension], data_state: 'final', ...info,
    });
    return { rows, coverage: info };
  }

  for (const length of WINDOW_LENGTHS) {
    const label = `${length}d`;
    const periods = comparisonPeriods(endDate, length);
    const totals = {};
    for (const side of ['current', 'previous']) {
      const period = periods[`${side}_period`];
      const response = await query(period, null, { limit: 1 });
      totals[side] = gscRows(response, null, period)[0] ?? null;
      if (!totals[side]) {
        partial = true;
        coverage.totals_complete = false;
        notes.push(`GSC_EMPTY_TOTALS_${label.toUpperCase()}_${side.toUpperCase()}`);
      }
      evidenceFor(`gsc_${label}_${side}_totals`, 'GSC independent period totals', {
        ...period, dimensions: [], data_state: 'final', totals_source: 'independent_dimensionless_query',
        response_aggregation_type: response.responseAggregationType ?? null,
        totals: totals[side],
      });
    }
    comparisons[label] = compareTotals(periods, totals.current, totals.previous, GSC_METRICS);
    movers[label] = {};
    coverage.details[label] = {};
    for (const [dimension, name] of [['page', 'pages'], ['query', 'queries']]) {
      const currentId = `gsc_${label}_current_${name}`;
      const previousId = `gsc_${label}_previous_${name}`;
      const current = await detailRows(periods.current_period, dimension, currentId);
      const previous = await detailRows(periods.previous_period, dimension, previousId);
      movers[label][name] = buildMovers(current.rows, previous.rows, { evidenceIds: [currentId, previousId] });
      coverage.details[label][name] = { current: current.coverage, previous: previous.coverage };
    }
  }
  return {
    source: {
      id: 'gsc', status: partial ? 'partial' : 'ok', collected_at: collectedAt,
      data_through: endDate, data_timezone: GSC_TIME_ZONE,
      reason: partial ? 'GSC_DATA_LIMITATIONS' : null,
    },
    seo: {
      data_through: endDate, data_timezone: GSC_TIME_ZONE, daily,
      comparisons, movers, coverage, notes,
    }, evidence,
  };
}

function ga4Metadata(response) {
  const metadata = response.metadata ?? {};
  if (!isObject(metadata)) fail('GA4_INVALID_RESPONSE', 'ga4');
  const flag = (name) => {
    if (metadata[name] === undefined) return false;
    if (typeof metadata[name] !== 'boolean') fail('GA4_INVALID_RESPONSE', 'ga4');
    return metadata[name];
  };
  const timeZone = metadata.timeZone ?? null;
  if (timeZone !== null) {
    if (typeof timeZone !== 'string' || !timeZone) fail('GA4_INVALID_RESPONSE', 'ga4');
    try { new Intl.DateTimeFormat('en', { timeZone }); } catch { fail('GA4_INVALID_RESPONSE', 'ga4'); }
  }
  const sampling = metadata.samplingMetadatas ?? [];
  if (!Array.isArray(sampling)) fail('GA4_INVALID_RESPONSE', 'ga4');
  const truncationReasons = metadata.dataTruncationReasons ?? [];
  if (!Array.isArray(truncationReasons) || truncationReasons.some((reason) => typeof reason !== 'string')) {
    fail('GA4_INVALID_RESPONSE', 'ga4');
  }
  return {
    time_zone: timeZone,
    subject_to_thresholding: flag('subjectToThresholding'),
    data_loss_from_other_row: flag('dataLossFromOtherRow'),
    data_truncation_reasons: truncationReasons,
    sampling: sampling.map((item) => {
      if (!isObject(item)) fail('GA4_INVALID_RESPONSE', 'ga4');
      return {
        samples_read_count: numberValue(item.samplesReadCount, 'ga4', { integer: true }),
        sampling_space_size: numberValue(item.samplingSpaceSize, 'ga4', { integer: true }),
      };
    }),
    empty_reason: typeof metadata.emptyReason === 'string' ? metadata.emptyReason.slice(0, 300) : null,
  };
}

function ga4Rows(response, dimension, period) {
  const rows = response.rows ?? [];
  const headers = response.metricHeaders ?? [];
  const dimensions = response.dimensionHeaders ?? [];
  if (!Array.isArray(rows) || !Array.isArray(headers) || !Array.isArray(dimensions)) {
    fail('GA4_INVALID_RESPONSE', 'ga4');
  }
  if (dimensions.length !== (dimension ? 1 : 0) ||
      (dimension && dimensions[0]?.name !== dimension)) fail('GA4_INVALID_RESPONSE', 'ga4');
  const names = headers.map((header) => header?.name);
  if (names.length !== Object.keys(GA4_METRICS).length || new Set(names).size !== names.length ||
      Object.keys(GA4_METRICS).some((name) => !names.includes(name))) fail('GA4_INVALID_RESPONSE', 'ga4');
  const rowCount = response.rowCount ?? rows.length;
  if (!Number.isSafeInteger(rowCount) || rowCount < rows.length || (!dimension && rowCount > 1)) {
    fail('GA4_INVALID_RESPONSE', 'ga4');
  }
  const seen = new Set();
  return rows.map((row) => {
    if (!Array.isArray(row?.metricValues) || row.metricValues.length !== names.length) {
      fail('GA4_INVALID_RESPONSE', 'ga4');
    }
    const metrics = Object.fromEntries(names.map((name, index) => [
      GA4_METRICS[name], numberValue(row.metricValues[index]?.value, 'ga4', { integer: name !== 'keyEvents' }),
    ]));
    const values = row.dimensionValues ?? [];
    if (!Array.isArray(values) || values.length !== dimensions.length) fail('GA4_INVALID_RESPONSE', 'ga4');
    if (!dimension) return metrics;
    const rawDate = values[0]?.value;
    if (typeof rawDate !== 'string' || !/^\d{8}$/.test(rawDate)) fail('GA4_INVALID_RESPONSE', 'ga4');
    const date = safeDate(`${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`, 'ga4');
    if (date < period.start_date || date > period.end_date || seen.has(date)) fail('GA4_INVALID_RESPONSE', 'ga4');
    seen.add(date);
    return { date, ...metrics };
  });
}

async function collectGa4(client, options, endDate, collectedAt) {
  const { ga4Property: property, historyDays, ga4Hostname } = options;
  if (!/^\d+$/.test(property)) fail('GA4_PROPERTY_INVALID', 'ga4');
  let hostname = null;
  if (ga4Hostname !== null) {
    if (typeof ga4Hostname !== 'string' || ga4Hostname.length > 253 ||
        !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(ga4Hostname)) {
      fail('GA4_HOSTNAME_INVALID', 'ga4');
    }
    hostname = ga4Hostname.toLowerCase();
  }
  const scope = hostname ? 'hostname' : 'whole_property';
  const channelFilter = { filter: {
    fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
  } };
  const dimensionFilter = hostname ? { andGroup: { expressions: [
    channelFilter,
    { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: hostname } } },
  ] } } : channelFilter;
  const endpoint = `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`;
  const evidenceUrl = `https://analytics.google.com/analytics/web/#/p${property}/reports/reportinghub`;
  const evidence = [];
  const metadata = [];
  const notes = [
    'GA4_ORGANIC_SEARCH_SESSIONS',
    'GA4_PERIOD_USERS_ARE_INDEPENDENT_DEDUPLICATED_TOTALS',
    'GA4_DATES_USE_PROPERTY_TIME_ZONE',
    'GA4_HAS_NO_FINAL_DATA_FLAG_AND_HISTORICAL_VALUES_CAN_CHANGE',
    'KEY_EVENTS_DEPEND_ON_PROPERTY_TRACKING_CONFIGURATION',
  ];
  notes.push(hostname
    ? `GA4 仅统计 hostname 为 ${hostname} 的 Organic Search 会话。`
    : 'GA4 未设置 hostname 过滤，范围为整个 property（whole_property），可能包含其他域，不能假设与 GSC 范围完全一致。');
  if (hostname && options.property.startsWith('sc-domain:')) {
    notes.push(`GSC 的 Domain property 覆盖全部子域，GA4 仅筛选 ${hostname}，两者范围不同；搜索点击与站内会话不能直接等同或合并。`);
  }
  let partial = false;
  async function query(period, dimension, id) {
    const response = await client.post(endpoint, {
      dateRanges: [{ startDate: period.start_date, endDate: period.end_date }],
      dimensions: dimension ? [{ name: dimension }] : [],
      metrics: Object.keys(GA4_METRICS).map((name) => ({ name })),
      dimensionFilter,
      limit: dimension ? historyDays + 1 : 1,
      returnPropertyQuota: true,
    }, 'ga4');
    const rows = ga4Rows(response, dimension, period);
    const info = ga4Metadata(response);
    metadata.push(info);
    if (!rows.length || info.empty_reason || info.subject_to_thresholding ||
        info.data_loss_from_other_row || info.sampling.length || info.data_truncation_reasons.length ||
        !info.time_zone || (response.rowCount ?? rows.length) > rows.length) partial = true;
    evidence.push({
      id, source_id: 'ga4', title: dimension ? 'GA4 daily organic search metrics' : 'GA4 independent organic period totals',
      observed_at: collectedAt, url: evidenceUrl,
      details: {
        ...period, dimensions: dimension ? [dimension] : [],
        filter: { session_default_channel_group: 'Organic Search', hostname, scope },
        returned_rows: rows.length, row_count: response.rowCount ?? rows.length,
        metadata: info, ...(dimension ? {} : { totals: rows[0] ?? null }),
      },
    });
    return rows;
  }
  const dailyPeriod = { start_date: shiftDate(endDate, 1 - historyDays), end_date: endDate };
  const daily = (await query(dailyPeriod, 'date', 'ga4_daily')).sort((a, b) => a.date.localeCompare(b.date));
  const missingDates = datesInPeriod(dailyPeriod.start_date, endDate)
    .filter((date) => !daily.some((row) => row.date === date));
  if (missingDates.length) notes.push('GA4_MISSING_DAILY_DATES_ARE_NOT_FILLED_WITH_ZERO');
  if (!daily.some((row) => row.date === endDate)) { partial = true; notes.push('GA4_CUTOFF_DATE_NOT_OBSERVED'); }
  const comparisons = {};
  for (const length of WINDOW_LENGTHS) {
    const label = `${length}d`;
    const periods = comparisonPeriods(endDate, length);
    const current = (await query(periods.current_period, null, `ga4_${label}_current_totals`))[0] ?? null;
    const previous = (await query(periods.previous_period, null, `ga4_${label}_previous_totals`))[0] ?? null;
    comparisons[label] = compareTotals(periods, current, previous, Object.values(GA4_METRICS));
  }
  const timeZones = [...new Set(metadata.map((item) => item.time_zone).filter(Boolean))];
  if (timeZones.length > 1) fail('GA4_TIMEZONE_CHANGED_DURING_RUN', 'ga4');
  const timeZone = timeZones[0] ?? null;
  return {
    source: {
      id: 'ga4', status: partial ? 'partial' : 'ok', collected_at: collectedAt,
      data_through: endDate, data_timezone: timeZone, reason: partial ? 'GA4_DATA_LIMITATIONS' : null,
    },
    analytics: {
      data_through: endDate, data_timezone: timeZone, daily, comparisons,
      coverage: {
        property_id: property, channel: 'Organic Search', hostname, scope, freshness: 'not_finalized',
        totals_source: 'independent_dimensionless_query',
        daily: { ...dailyPeriod, returned_rows: daily.length, missing_dates: missingDates, missing_dates_are_zero: false },
        metadata,
      }, notes,
    }, evidence,
  };
}

/** Unconfigured Google sources remain absent; configured sources must authenticate. */
export async function collectGoogle(config, {
  env = process.env, fetchImpl = fetch, now = new Date(), asOf,
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('GOOGLE_DATE_INVALID', 'gsc');
  const collectedAt = now.toISOString();
  // Only an omitted or empty secret is optional. A nonempty malformed credential
  // must still fail instead of disguising an access problem as missing data.
  if (env.GOOGLE_CREDENTIALS_JSON === undefined || env.GOOGLE_CREDENTIALS_JSON === '') {
    const ga4Property = config?.ga4?.property_id;
    const ga4Configured = ga4Property !== null && ga4Property !== undefined && ga4Property !== '';
    return {
      sources: [
        { id: 'gsc', status: 'not_configured', collected_at: collectedAt,
          data_through: null, data_timezone: GSC_TIME_ZONE, reason: '未配置 Google 凭证；本次不包含搜索效果数据。' },
        { id: 'ga4', status: 'not_configured', collected_at: collectedAt,
          data_through: null, data_timezone: null, reason: ga4Configured
            ? '未配置 Google 凭证；本次不包含 GA4 数据。' : '未配置 GA4 属性；本次不包含站内分析数据。' },
      ],
      seo: null, analytics: null, evidence: [],
    };
  }
  const options = validatedOptions(config, now, asOf);
  const credentials = readCredentials(env);
  const scopes = options.ga4Configured ? [GSC_SCOPE, GA4_SCOPE] : [GSC_SCOPE];
  const client = createGoogleClient(credentials, scopes, fetchImpl, now);
  const gsc = await collectGsc(client, options, collectedAt);
  const sources = [gsc.source];
  let analytics = null;
  const evidence = [...gsc.evidence];
  if (!options.ga4Configured) {
    sources.push({
      id: 'ga4', status: 'not_configured', collected_at: collectedAt,
      data_through: null, data_timezone: null, reason: 'GA4_NOT_CONFIGURED',
    });
  } else {
    try {
      const ga4 = await collectGa4(client, options, gsc.seo.data_through, collectedAt);
      analytics = ga4.analytics;
      if (options.property.startsWith('sc-domain:') && ga4.analytics.coverage.hostname) {
        gsc.seo.notes.push(`GSC 覆盖 Domain property 的所有子域，GA4 仅筛选 hostname ${ga4.analytics.coverage.hostname}；两者统计范围不同。`);
      }
      sources.push(ga4.source);
      evidence.push(...ga4.evidence);
    } catch (error) {
      const code = error instanceof GoogleCollectionError ? error.code : 'GA4_COLLECTION_FAILED';
      sources.push({
        id: 'ga4', status: 'error', collected_at: collectedAt,
        data_through: null, data_timezone: null, reason: code,
      });
      evidence.push({
        id: 'ga4_error', source_id: 'ga4', title: 'GA4 collection failed', observed_at: collectedAt,
        url: 'https://developers.google.com/analytics/devguides/reporting/data/v1',
        details: { code },
      });
    }
  }
  return { sources, seo: gsc.seo, analytics, evidence };
}
