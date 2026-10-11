import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { collectGoogle, GoogleCollectionError } from '../src/google.mjs';

const NOW = new Date('2026-10-11T16:00:00Z');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CONFIG = {
  id: 'nocobase', name: 'NocoBase', url: 'https://www.nocobase.com', timezone: 'Asia/Shanghai',
  gsc: { property: 'sc-domain:nocobase.com', search_type: 'web', history_days: 90, detail_limit: 2 },
  ga4: { property_id: null },
};
const ENV = { GOOGLE_CREDENTIALS_JSON: JSON.stringify({
  type: 'authorized_user', client_id: 'fixture-client-id',
  client_secret: 'fixture-client-secret', refresh_token: 'fixture-refresh-token',
}) };

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function dateOffset(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function gscRow(key, clicks = 10) {
  return {
    ...(key === null ? {} : { keys: [key] }),
    clicks, impressions: clicks * 10, ctr: clicks ? 0.1 : 0, position: clicks ? 8.123456789 : 0,
  };
}

function ga4Response(body, { empty = false, metadata = {} } = {}) {
  // Return headers in an order different from the request to catch positional parsing bugs.
  const metricHeaders = [{ name: 'keyEvents' }, { name: 'activeUsers' }, { name: 'sessions' }];
  const daily = body.dimensions.length > 0;
  const period = body.dateRanges[0];
  const values = daily ? [0.5, 10, 20] : [2.5, 15, 40];
  const metricValues = values.map((value) => ({ value: String(value) }));
  const rows = empty ? [] : daily
    ? [-2, -1, 0].map((offset) => ({
      dimensionValues: [{ value: dateOffset(period.endDate, offset).replaceAll('-', '') }], metricValues,
    }))
    : [{ metricValues }];
  return {
    metricHeaders, dimensionHeaders: daily ? [{ name: 'date' }] : [], rows,
    rowCount: rows.length, metadata: { timeZone: 'Asia/Shanghai', ...metadata },
  };
}

function fixture({
  firstIncomplete = '2026-10-09', finalDates = ['2026-10-07', '2026-10-08'],
  intercept, ga4Metadata = {}, emptyGscTotals = false, emptyGa4Totals = false,
} = {}) {
  const calls = [];
  let tokenCount = 0;
  const fetchImpl = async (url, init) => {
    const body = url === TOKEN_URL ? new URLSearchParams(init.body) : JSON.parse(init.body);
    const call = { url, init, body };
    calls.push(call);
    const intercepted = await intercept?.(call, calls);
    if (intercepted !== undefined) return intercepted;
    if (url === TOKEN_URL) {
      tokenCount += 1;
      return json({ access_token: `fixture-access-token-${tokenCount}`, expires_in: 3600 });
    }
    if (url.includes('/searchAnalytics/query')) {
      const dimension = body.dimensions[0];
      const aggregation = dimension === 'page' ? 'byPage' : 'byProperty';
      if (body.dataState === 'all') {
        return json({
          rows: ['2026-10-08', '2026-10-09', '2026-10-10'].map((date) => gscRow(date)),
          responseAggregationType: aggregation,
          ...(firstIncomplete === null ? {} : { metadata: { first_incomplete_date: firstIncomplete } }),
        });
      }
      if (dimension === 'date') {
        const dates = body.startDate === '2026-09-27' && body.endDate === '2026-10-10'
          ? finalDates : [-2, -1, 0].map((offset) => dateOffset(body.endDate, offset));
        return json({ rows: dates.map((date) => gscRow(date)), responseAggregationType: aggregation });
      }
      if (!dimension) {
        const current = body.endDate === '2026-10-08';
        const count = current ? 100 : 80;
        return json({
          rows: emptyGscTotals && current ? [] : [gscRow(null, count)],
          responseAggregationType: aggregation,
        });
      }
      const current = body.endDate === '2026-10-08';
      const prefix = dimension === 'page' ? 'https://www.nocobase.com/' : 'query-';
      return json({ rows: [
        gscRow(`${prefix}shared`, current ? 8 : 10),
        gscRow(`${prefix}${current ? 'current-only' : 'previous-only'}`, current ? 2 : 3),
      ], responseAggregationType: aggregation });
    }
    if (url.includes('analyticsdata.googleapis.com')) {
      return json(ga4Response(body, {
        empty: emptyGa4Totals && body.dimensions.length === 0 && body.dateRanges[0].endDate === '2026-10-08',
        metadata: ga4Metadata,
      }));
    }
    throw new Error('Unexpected fixture endpoint');
  };
  return { calls, fetchImpl, tokenCount: () => tokenCount };
}

test('missing, malformed, or redirected credentials fail before any network request', async () => {
  for (const [env, code] of [
    [{}, 'GOOGLE_CREDENTIALS_MISSING'],
    [{ GOOGLE_CREDENTIALS_JSON: '{private broken json' }, 'GOOGLE_CREDENTIALS_INVALID'],
    [{ GOOGLE_CREDENTIALS_JSON: JSON.stringify({
      ...JSON.parse(ENV.GOOGLE_CREDENTIALS_JSON), token_uri: 'https://attacker.invalid/token',
    }) }, 'GOOGLE_CREDENTIALS_INVALID'],
  ]) {
    let requests = 0;
    await assert.rejects(collectGoogle(CONFIG, { env, now: NOW, fetchImpl: () => { requests += 1; } }),
      (error) => error instanceof GoogleCollectionError && error.code === code && !error.message.includes('private'));
    assert.equal(requests, 0);
  }
});

test('final boundary, exact comparison ranges, independent totals, and observed-only movers', async () => {
  const mock = fixture();
  const result = await collectGoogle(CONFIG, { env: ENV, now: NOW, fetchImpl: mock.fetchImpl });
  assert.equal(result.seo.data_through, '2026-10-08');
  assert.equal(result.seo.data_timezone, 'America/Los_Angeles');
  assert.ok(result.seo.notes.some((note) => note.includes('所有子域与协议')));
  assert.equal(result.seo.coverage.cutoff.first_incomplete_date, '2026-10-09');
  assert.equal(result.seo.comparisons['7d'].metrics.clicks.current, 100);
  assert.equal(result.seo.daily.length, 3);
  assert.equal(result.seo.daily.reduce((sum, row) => sum + row.clicks, 0), 30);
  assert.equal(result.seo.comparisons['7d'].metrics.position.current, 8.123456789);
  assert.deepEqual(result.seo.comparisons['28d'].previous_period, {
    start_date: '2026-08-14', end_date: '2026-09-10',
  });
  const totals = mock.calls.filter((call) => call.url.includes('/searchAnalytics/query') && call.body.dimensions.length === 0);
  assert.equal(totals.length, 4);
  assert.ok(totals.every((call) => call.body.dataState === 'final' && call.body.rowLimit === 1));
  assert.deepEqual(totals.map((call) => [call.body.startDate, call.body.endDate]), [
    ['2026-10-02', '2026-10-08'], ['2026-09-25', '2026-10-01'],
    ['2026-09-11', '2026-10-08'], ['2026-08-14', '2026-09-10'],
  ]);
  const unseen = result.seo.movers['7d'].pages.find((row) => row.key.endsWith('previous-only'));
  assert.equal(unseen.current, null);
  assert.equal(unseen.click_change, null);
  assert.equal(result.seo.coverage.details['7d'].pages.current.exhaustive, false);
  assert.equal(result.seo.coverage.details['7d'].pages.current.at_requested_limit, true);
  assert.equal(result.analytics, null);
  assert.equal(result.sources.find((source) => source.id === 'ga4').status, 'not_configured');
  assert.equal(mock.tokenCount(), 1);
  assert.ok(!JSON.stringify(result).includes('fixture-access-token'));
});

test('manual end dates may not exceed the verified final boundary', async () => {
  const mock = fixture();
  await assert.rejects(collectGoogle(CONFIG, {
    env: ENV, now: NOW, asOf: '2026-10-09', fetchImpl: mock.fetchImpl,
  }), (error) => error.code === 'GSC_AS_OF_NOT_FINAL');
  assert.equal(mock.calls.filter((call) => call.url.includes('/searchAnalytics/query')).length, 2);
  const older = fixture();
  const result = await collectGoogle(CONFIG, { env: ENV, now: NOW, asOf: '2026-10-07', fetchImpl: older.fetchImpl });
  assert.equal(result.seo.data_through, '2026-10-07');
  assert.equal(result.seo.comparisons['7d'].current_period.start_date, '2026-10-01');
});

test('unknown availability is not reported as zero, and stale final data is disclosed', async () => {
  const empty = fixture({ finalDates: [] });
  await assert.rejects(collectGoogle(CONFIG, { env: ENV, now: NOW, fetchImpl: empty.fetchImpl }),
    (error) => error.code === 'GSC_NO_FINAL_DATA');
  const stale = fixture({ firstIncomplete: null, finalDates: ['2026-10-06'] });
  const result = await collectGoogle(CONFIG, { env: ENV, now: NOW, fetchImpl: stale.fetchImpl });
  assert.equal(result.seo.data_through, '2026-10-06');
  assert.equal(result.sources[0].status, 'partial');
  assert.equal(result.seo.coverage.cutoff.method, 'latest_observed_final_date');
  assert.ok(result.seo.notes.includes('GSC_FINAL_DATA_LAG'));
  assert.equal(result.seo.coverage.daily.missing_dates_are_zero, false);
});

test('empty independent totals remain null and never fall back to summing detail rows', async () => {
  const mock = fixture({ emptyGscTotals: true });
  const result = await collectGoogle(CONFIG, { env: ENV, now: NOW, fetchImpl: mock.fetchImpl });
  assert.equal(result.sources[0].status, 'partial');
  assert.equal(result.seo.comparisons['7d'].metrics.clicks.current, null);
  assert.equal(result.seo.comparisons['7d'].metrics.clicks.absolute_change, null);
  assert.equal(result.seo.coverage.totals_complete, false);
  assert.ok(result.seo.movers['7d'].pages.length > 0);
});

test('an observed zero count is retained while a rank with no impressions is undefined', async () => {
  const mock = fixture({ intercept: (call) => {
    if (call.url.includes('/searchAnalytics/query') && call.body.dimensions.length === 0 &&
        call.body.endDate === '2026-10-01') {
      return json({ rows: [gscRow(null, 0)], responseAggregationType: 'byProperty' });
    }
  } });
  const result = await collectGoogle(CONFIG, { env: ENV, now: NOW, fetchImpl: mock.fetchImpl });
  const comparison = result.seo.comparisons['7d'].metrics;
  assert.equal(comparison.clicks.previous, 0);
  assert.equal(comparison.clicks.relative_change, null);
  assert.equal(comparison.position.previous, null);
  assert.equal(comparison.position.absolute_change, null);
  assert.equal(comparison.ctr.previous, null);
});

test('service account assertion is signed correctly and requests only needed scopes', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let claims;
  const mock = fixture({ intercept: (call) => {
    if (call.url !== TOKEN_URL) return;
    assert.equal(call.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, payload, signature] = call.body.get('assertion').split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
    claims = JSON.parse(Buffer.from(payload, 'base64url'));
  } });
  const env = { GOOGLE_CREDENTIALS_JSON: JSON.stringify({
    type: 'service_account', client_email: 'fixture@project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: TOKEN_URL,
  }) };
  await collectGoogle(CONFIG, { env, now: NOW, fetchImpl: mock.fetchImpl });
  assert.equal(claims.aud, TOKEN_URL);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/webmasters.readonly');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(claims.iss, 'fixture@project.iam.gserviceaccount.com');
});

test('expired API authentication refreshes once using the refresh token', async () => {
  let first = true;
  const mock = fixture({ intercept: (call) => {
    if (call.url === TOKEN_URL) {
      assert.equal(call.body.get('grant_type'), 'refresh_token');
      assert.equal(call.body.get('refresh_token'), 'fixture-refresh-token');
    } else if (first) {
      first = false;
      return json({ error: 'sensitive provider body' }, 401);
    }
  } });
  const result = await collectGoogle(CONFIG, { env: ENV, now: NOW, fetchImpl: mock.fetchImpl });
  assert.equal(result.sources[0].status, 'ok');
  assert.equal(mock.tokenCount(), 2);
  assert.ok(mock.calls.filter((call) => call.url !== TOKEN_URL).slice(1)
    .every((call) => call.init.headers.authorization === 'Bearer fixture-access-token-2'));
});

test('rate limits retry a bounded number of times and permanent errors expose no body', async () => {
  let attempts = 0;
  const limited = fixture({ intercept: (call) => {
    if (call.url !== TOKEN_URL && ++attempts <= 2) return json({ error: 'private' }, 429, { 'retry-after': '0' });
  } });
  await collectGoogle(CONFIG, { env: ENV, now: NOW, fetchImpl: limited.fetchImpl });
  assert.equal(limited.calls.filter((call) => call.body.dataState === 'all').length, 3);
  let failures = 0;
  const broken = fixture({ intercept: (call) => {
    if (call.url !== TOKEN_URL) { failures += 1; return json({ error: 'fixture-secret-never-log' }, 503, { 'retry-after': '0' }); }
  } });
  await assert.rejects(collectGoogle(CONFIG, { env: ENV, now: NOW, fetchImpl: broken.fetchImpl }), (error) => {
    assert.equal(error.code, 'GSC_HTTP_ERROR');
    assert.equal(error.http_status, 503);
    assert.ok(!JSON.stringify(error).includes('fixture-secret-never-log'));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(failures, 3);
});

test('network and token failures cannot leak thrown messages or provider bodies', async () => {
  let failures = 0;
  const network = fixture({ intercept: (call) => {
    if (call.url !== TOKEN_URL) { failures += 1; throw new Error('fixture-private-authorization'); }
  } });
  await assert.rejects(collectGoogle(CONFIG, { env: ENV, now: NOW, fetchImpl: network.fetchImpl }), (error) => {
    assert.equal(error.message, 'GSC_NETWORK_ERROR');
    assert.ok(!JSON.stringify(error).includes('fixture-private-authorization'));
    return true;
  });
  assert.equal(failures, 3);
  const auth = fixture({ intercept: (call) => call.url === TOKEN_URL
    ? json({ error: 'invalid_grant', error_description: 'fixture-private-credentials' }, 400) : undefined });
  await assert.rejects(collectGoogle(CONFIG, { env: ENV, now: NOW, fetchImpl: auth.fetchImpl }), (error) => {
    assert.equal(error.code, 'GOOGLE_AUTH_HTTP_ERROR');
    assert.equal(error.http_status, 400);
    assert.ok(!JSON.stringify(error).includes('fixture-private-credentials'));
    return true;
  });
  assert.equal(auth.calls.length, 1);
});

test('GA4 uses independent range users, header names, and source metadata', async () => {
  const mock = fixture();
  const config = { ...CONFIG, ga4: { property_id: '123456' } };
  const result = await collectGoogle(config, { env: ENV, now: NOW, fetchImpl: mock.fetchImpl });
  assert.equal(result.analytics.daily.reduce((sum, row) => sum + row.active_users, 0), 30);
  assert.equal(result.analytics.comparisons['7d'].metrics.active_users.current, 15);
  assert.equal(result.analytics.comparisons['7d'].metrics.sessions.current, 40);
  assert.equal(result.analytics.comparisons['7d'].metrics.key_events.current, 2.5);
  assert.equal(result.analytics.data_timezone, 'Asia/Shanghai');
  assert.equal(result.analytics.coverage.freshness, 'not_finalized');
  assert.equal(result.analytics.coverage.hostname, null);
  assert.equal(result.analytics.coverage.scope, 'whole_property');
  assert.ok(result.analytics.notes.some((note) => note.includes('whole_property')));
  assert.ok(result.evidence.filter((entry) => entry.source_id === 'ga4')
    .every((entry) => entry.details.filter.scope === 'whole_property' && entry.details.filter.hostname === null));
  const calls = mock.calls.filter((call) => call.url.includes('analyticsdata.googleapis.com'));
  assert.equal(calls.length, 5);
  assert.equal(calls.filter((call) => call.body.dimensions.length === 0).length, 4);
  assert.ok(calls.every((call) => call.body.dimensionFilter.filter.stringFilter.value === 'Organic Search'));
});

test('GA4 hostname and channel are both enforced, including totals, and scope differences are explicit', async () => {
  const mock = fixture({ intercept: (call) => {
    if (!call.url.includes('analyticsdata.googleapis.com')) return;
    const filters = call.body.dimensionFilter?.andGroup?.expressions?.map((item) => item.filter) ?? [];
    const host = filters.find((filter) => filter.fieldName === 'hostName');
    const channel = filters.find((filter) => filter.fieldName === 'sessionDefaultChannelGroup');
    if (host?.stringFilter?.value !== 'www.nocobase.com' || channel?.stringFilter?.value !== 'Organic Search') {
      // A request without both filters would accidentally include another website.
      const response = ga4Response(call.body);
      response.rows.forEach((row) => { row.metricValues[2].value = '999999'; });
      return json(response);
    }
  } });
  const result = await collectGoogle({ ...CONFIG, ga4: { property_id: '123456', hostname: 'www.nocobase.com' } }, {
    env: ENV, now: NOW, fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.analytics.comparisons['7d'].metrics.sessions.current, 40);
  assert.equal(result.analytics.coverage.hostname, 'www.nocobase.com');
  assert.equal(result.analytics.coverage.scope, 'hostname');
  const calls = mock.calls.filter((call) => call.url.includes('analyticsdata.googleapis.com'));
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => {
    const expressions = call.body.dimensionFilter.andGroup.expressions;
    return expressions.length === 2 && expressions.every((item) => item.filter.stringFilter.matchType === 'EXACT');
  }));
  assert.ok(result.evidence.filter((entry) => entry.source_id === 'ga4').every((entry) =>
    entry.details.filter.hostname === 'www.nocobase.com' && entry.details.filter.scope === 'hostname'));
  assert.ok(result.analytics.notes.some((note) => note.includes('两者范围不同')));
  assert.ok(result.seo.notes.some((note) => note.includes('www.nocobase.com') && note.includes('统计范围不同')));
});

test('invalid GA4 hostname is rejected instead of silently broadening the property scope', async () => {
  const mock = fixture();
  const result = await collectGoogle({ ...CONFIG, ga4: { property_id: '123456', hostname: 'https://www.nocobase.com/' } }, {
    env: ENV, now: NOW, fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.analytics, null);
  assert.equal(result.sources.find((source) => source.id === 'ga4').reason, 'GA4_HOSTNAME_INVALID');
  assert.equal(mock.calls.filter((call) => call.url.includes('analyticsdata.googleapis.com')).length, 0);
});

test('configured GA4 failure is an error source with no invented analytics', async () => {
  const mock = fixture({ intercept: (call) => call.url.includes('analyticsdata.googleapis.com')
    ? json({ error: 'fixture-private-token-in-error' }, 403) : undefined });
  const result = await collectGoogle({ ...CONFIG, ga4: { property_id: '123456' } }, {
    env: ENV, now: NOW, fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.analytics, null);
  assert.equal(result.sources.find((source) => source.id === 'ga4').status, 'error');
  assert.equal(result.sources.find((source) => source.id === 'ga4').reason, 'GA4_HTTP_ERROR');
  assert.equal(result.seo.comparisons['7d'].metrics.clicks.current, 100);
  assert.ok(!JSON.stringify(result).includes('fixture-private-token-in-error'));
});

test('empty and thresholded GA4 data remains qualified rather than a false zero', async () => {
  const mock = fixture({ emptyGa4Totals: true, ga4Metadata: {
    subjectToThresholding: true, dataLossFromOtherRow: true,
    samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }],
  } });
  const result = await collectGoogle({ ...CONFIG, ga4: { property_id: '123456' } }, {
    env: ENV, now: NOW, fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.sources.find((source) => source.id === 'ga4').status, 'partial');
  assert.equal(result.analytics.comparisons['7d'].metrics.active_users.current, null);
  assert.equal(result.analytics.coverage.metadata[0].subject_to_thresholding, true);
  assert.equal(result.analytics.coverage.metadata[0].sampling[0].sampling_space_size, 100);
});

test('details paginate beyond 25000 without ever claiming complete Search Console coverage', async () => {
  const mock = fixture({ intercept: (call) => {
    const { body } = call;
    if (!call.url.includes('/searchAnalytics/query') || body.dimensions[0] !== 'page' ||
        body.startDate !== '2026-10-02') return;
    const count = body.startRow === 0 ? 25000 : 1;
    return json({ rows: Array.from({ length: count }, (_, index) =>
      gscRow(`https://www.nocobase.com/page-${body.startRow + index}`, 1)), responseAggregationType: 'byPage' });
  } });
  const result = await collectGoogle({ ...CONFIG, gsc: { ...CONFIG.gsc, detail_limit: 25001 } }, {
    env: ENV, now: NOW, fetchImpl: mock.fetchImpl,
  });
  const detail = result.seo.coverage.details['7d'].pages.current;
  assert.equal(detail.returned_rows, 25001);
  assert.equal(detail.exhaustive, false);
  assert.equal(detail.pagination_exhausted, false);
  assert.ok(mock.calls.some((call) => call.body.startRow === 25000 && call.body.rowLimit === 1));
  assert.ok(result.seo.movers['7d'].pages.length <= 20);
  assert.ok(JSON.stringify(result.evidence).length < 30000);
});
