// Framework-independent R2 storage. Authentication and HTML response headers belong
// to the HTTP boundary; this module never logs payloads or provider exceptions.
// R2 put(onlyIf) returns null on a failed condition, rather than throwing:
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
const REPOSITORY = 'gchust/nocobase-growth-reports';
const REPOSITORY_ID = 1414200278;
const INDEX_KEY = 'metadata/index.json';
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_BYTES = 512 * 1024;
const MAX_REPORTS = 365;
const MAX_INDEX_ATTEMPTS = 3;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const SHA = /^[a-f0-9]{40}$/;
const BASE_KEYS = ['schema_version', 'repository', 'repository_id', 'report_date',
  'run_id', 'attempt', 'code_sha', 'data_through', 'report_status'];
const META_KEYS = [...BASE_KEYS, 'report_id', 'html_sha256', 'html_bytes'];
const encoder = new TextEncoder();

export class ReportStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReportStoreError';
    this.code = code;
  }
}

function fail(code) { throw new ReportStoreError(code); }

async function guarded(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ReportStoreError) throw error;
    fail('VIEWER_STORAGE_ERROR');
  }
}

async function storage(operation) {
  try { return await operation(); }
  catch { fail('VIEWER_STORAGE_ERROR'); }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

function validDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validAttempt(value) {
  return Number.isInteger(value) && value >= 1 && value <= 1000;
}

function idFor(value) { return `${value.report_date}/${value.run_id}-${value.attempt}`; }
function objectKey(id) { return `reports/${id}.html`; }

function validateBase(value, code) {
  if (value.schema_version !== 1 || value.repository !== REPOSITORY
      || value.repository_id !== REPOSITORY_ID || !validDate(value.report_date)
      || typeof value.run_id !== 'string' || !RUN_ID.test(value.run_id)
      || !validAttempt(value.attempt) || typeof value.code_sha !== 'string' || !SHA.test(value.code_sha)
      || (value.data_through !== null && !validDate(value.data_through))
      || (value.data_through !== null && value.data_through > value.report_date)
      || !['complete', 'limited'].includes(value.report_status)
      || (value.data_through === null && value.report_status !== 'limited')) fail(code);
  return Object.fromEntries(BASE_KEYS.map((key) => [key, value[key]]));
}

function validateId(id) {
  if (typeof id !== 'string') fail('VIEWER_INVALID_REPORT_ID');
  const match = /^(20\d{2}-\d{2}-\d{2})\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})-([1-9]\d{0,3})$/.exec(id);
  if (!match || !validDate(match[1]) || !validAttempt(Number(match[3]))) fail('VIEWER_INVALID_REPORT_ID');
  return id;
}

function htmlBytes(html, code) {
  if (typeof html !== 'string') fail(code);
  const sizeCode = code === 'VIEWER_INVALID_PAYLOAD' ? 'VIEWER_HTML_TOO_LARGE' : code;
  // UTF-8 can only be longer; avoid allocating another huge string or byte array.
  if (html.length > MAX_HTML_BYTES) fail(sizeCode);
  if (!html.trim()) fail(code);
  // Reject unpaired UTF-16 surrogates: UTF-8 replacement would change the input.
  if (typeof html.isWellFormed === 'function' && !html.isWellFormed()) fail(code);
  const bytes = encoder.encode(html);
  if (bytes.byteLength > MAX_HTML_BYTES) fail(sizeCode);
  return bytes;
}

async function digest(bytes) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function validateMetadata(value) {
  const code = 'VIEWER_STORAGE_INVALID';
  if (!exactKeys(value, META_KEYS)) fail(code);
  const base = validateBase(value, code);
  if (value.report_id !== idFor(base) || typeof value.html_sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.html_sha256) || !Number.isInteger(value.html_bytes)
      || value.html_bytes < 1 || value.html_bytes > MAX_HTML_BYTES) fail(code);
  return { ...base, report_id: value.report_id, html_sha256: value.html_sha256, html_bytes: value.html_bytes };
}

function parseStoredJson(text, maxBytes) {
  if (typeof text !== 'string' || encoder.encode(text).byteLength > maxBytes) fail('VIEWER_STORAGE_INVALID');
  try { return JSON.parse(text); }
  catch { fail('VIEWER_STORAGE_INVALID'); }
}

function sameMetadata(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function sortReports(a, b) {
  if (a.report_date !== b.report_date) return a.report_date > b.report_date ? -1 : 1;
  if (a.run_id !== b.run_id) return a.run_id > b.run_id ? -1 : 1;
  return b.attempt - a.attempt;
}

async function readIndex(bucket) {
  const object = await storage(() => bucket.get(INDEX_KEY));
  if (object === null) return { etag: null, index: { schema_version: 1, latest: null, reports: [] } };
  if (!Number.isInteger(object.size) || object.size < 1 || object.size > MAX_INDEX_BYTES
      || typeof object.etag !== 'string' || !object.etag) fail('VIEWER_STORAGE_INVALID');
  const data = parseStoredJson(await storage(() => object.text()), MAX_INDEX_BYTES);
  if (!exactKeys(data, ['schema_version', 'latest', 'reports']) || data.schema_version !== 1
      || !Array.isArray(data.reports) || data.reports.length > MAX_REPORTS) fail('VIEWER_STORAGE_INVALID');
  const reports = data.reports.map(validateMetadata);
  const latest = data.latest === null ? null : validateMetadata(data.latest);
  if ((latest === null) !== (reports.length === 0)
      || new Set(reports.map((report) => report.report_id)).size !== reports.length) fail('VIEWER_STORAGE_INVALID');
  const listedLatest = reports.find((report) => report.report_id === latest?.report_id);
  if (listedLatest && !sameMetadata(listedLatest, latest)) fail('VIEWER_STORAGE_INVALID');
  return { etag: object.etag, index: { schema_version: 1, latest, reports: reports.sort(sortReports) } };
}

async function readStoredReport(bucket, reportId) {
  const object = await storage(() => bucket.get(objectKey(reportId)));
  if (object === null) return null;
  const metadata = validateMetadata(parseStoredJson(object.customMetadata?.report, 4096));
  if (metadata.report_id !== reportId || object.size !== metadata.html_bytes) fail('VIEWER_STORAGE_INVALID');
  const html = await storage(() => object.text());
  const bytes = htmlBytes(html, 'VIEWER_STORAGE_INVALID');
  if (bytes.byteLength !== metadata.html_bytes || await digest(bytes) !== metadata.html_sha256) fail('VIEWER_STORAGE_INVALID');
  return { metadata, html };
}

function advancesLatest(previous, next) {
  return previous === null || (next.report_date > previous.report_date
    && (previous.data_through === null
      || (next.data_through !== null && next.data_through >= previous.data_through)));
}

/**
 * Store immutable HTML and its metadata atomically in one R2 object, then update
 * metadata/index.json with at most three compare-and-swap attempts. A retry after
 * an interrupted index write repairs the directory without rewriting the HTML.
 * Returns { status: 'published' | 'unchanged', report_id }.
 */
export async function publishReport(bucket, payload) {
  return guarded(async () => {
    if (!exactKeys(payload, [...BASE_KEYS, 'html'])) fail('VIEWER_INVALID_PAYLOAD');
    const base = validateBase(payload, 'VIEWER_INVALID_PAYLOAD');
    const bytes = htmlBytes(payload.html, 'VIEWER_INVALID_PAYLOAD');
    const metadata = { ...base, report_id: idFor(base), html_sha256: await digest(bytes), html_bytes: bytes.byteLength };
    // If-None-Match:* is an atomic create-only condition, including for a missing key.
    const stored = await storage(() => bucket.put(objectKey(metadata.report_id), bytes, {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
      httpMetadata: { contentType: 'text/html; charset=utf-8', cacheControl: 'private, no-store' },
      customMetadata: { report: JSON.stringify(metadata) },
    }));
    if (stored === null) {
      const existing = await readStoredReport(bucket, metadata.report_id);
      if (!existing) fail('VIEWER_STORAGE_INVALID');
      if (!sameMetadata(existing.metadata, metadata) || existing.html !== payload.html) fail('VIEWER_REPORT_CONFLICT');
    }

    for (let attempt = 0; attempt < MAX_INDEX_ATTEMPTS; attempt += 1) {
      const { etag, index } = await readIndex(bucket);
      const existing = index.reports.find((report) => report.report_id === metadata.report_id);
      if (existing && !sameMetadata(existing, metadata)) fail('VIEWER_STORAGE_INVALID');
      const latest = advancesLatest(index.latest, metadata) ? metadata : index.latest;
      const reports = [...index.reports.filter((report) => report.report_id !== metadata.report_id), metadata]
        .sort(sortReports).slice(0, MAX_REPORTS);
      const next = { schema_version: 1, latest, reports };
      if (JSON.stringify(index) === JSON.stringify(next)) return { status: 'unchanged', report_id: metadata.report_id };
      const result = await storage(() => bucket.put(INDEX_KEY, JSON.stringify(next), {
        onlyIf: etag === null ? new Headers({ 'If-None-Match': '*' }) : { etagMatches: etag },
        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
      }));
      if (result !== null) return { status: 'published', report_id: metadata.report_id };
    }
    fail('VIEWER_INDEX_CONFLICT');
  });
}

/** Returns { latest: metadata | null, reports: metadata[] }, newest dates first. */
export async function listReports(bucket) {
  return guarded(async () => {
    const { index } = await readIndex(bucket);
    return { latest: index.latest, reports: index.reports };
  });
}

/** Only accepts YYYY-MM-DD/run_id-attempt; no keys, URLs or path traversal. */
export async function readReport(bucket, reportId) {
  return guarded(() => readStoredReport(bucket, validateId(reportId)));
}
