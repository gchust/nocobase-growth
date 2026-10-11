import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportStoreError, publishReport, listReports, readReport } from '../viewer/server/report-store.mjs';

const INDEX = 'metadata/index.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function payload(overrides = {}) {
  return {
    schema_version: 1, repository: 'gchust/nocobase-growth-reports', repository_id: 1414200278,
    report_date: '2026-10-11', run_id: '100', attempt: 1, code_sha: 'a'.repeat(40),
    data_through: '2026-10-08', report_status: 'complete',
    html: '<!doctype html><html lang="zh-CN"><title>合成日报</title><body>仅测试数据</body></html>',
    ...overrides,
  };
}

// Synthetic R2 implementation: reads see snapshots, conditional puts are atomic.
// Hooks force real interleavings rather than relying on event-loop timing.
class MemoryBucket {
  objects = new Map();
  calls = [];
  sequence = 0;
  onGet = null;
  onPut = null;

  object(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    return { key, etag: item.etag, size: encoder.encode(item.body).byteLength,
      customMetadata: structuredClone(item.customMetadata), text: async () => item.body };
  }

  async get(key) {
    this.calls.push({ method: 'get', key });
    const snapshot = this.object(key);
    if (this.onGet) await this.onGet(key, snapshot);
    return snapshot;
  }

  async put(key, value, options = {}) {
    this.calls.push({ method: 'put', key, options });
    if (this.onPut && await this.onPut(key, value, options) === false) return null;
    const current = this.objects.get(key);
    const condition = options.onlyIf;
    assert.ok(condition, 'every write must have a condition');
    if (condition instanceof Headers) {
      assert.equal(condition.get('If-None-Match'), '*');
      if (current) return null;
    } else {
      assert.equal(typeof condition.etagMatches, 'string');
      if (current?.etag !== condition.etagMatches) return null;
    }
    const body = typeof value === 'string' ? value : decoder.decode(value);
    this.objects.set(key, { body, customMetadata: structuredClone(options.customMetadata ?? {}),
      etag: `etag-${++this.sequence}` });
    return this.object(key);
  }
}

function fixedError(code) {
  return (error) => error instanceof ReportStoreError && error.code === code
    && error.message === code && error.cause === undefined;
}

function barrier(count) {
  let pending = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return async () => {
    pending += 1;
    if (pending === count) release();
    await ready;
  };
}

test('empty storage lists no reports and missing legal IDs return null', async () => {
  const bucket = new MemoryBucket();
  assert.deepEqual(await listReports(bucket), { latest: null, reports: [] });
  assert.equal(await readReport(bucket, '2026-10-11/100-1'), null);
  assert.equal(bucket.objects.size, 0);
});

test('publish stores HTML plus metadata atomically, reads exact bytes and retries idempotently', async () => {
  const bucket = new MemoryBucket();
  const value = payload();
  const original = structuredClone(value);
  const first = await publishReport(bucket, value);
  assert.deepEqual(first, { status: 'published', report_id: '2026-10-11/100-1' });
  assert.deepEqual(value, original, 'caller payload is unchanged');
  assert.deepEqual([...bucket.objects.keys()].sort(), [INDEX, 'reports/2026-10-11/100-1.html']);
  const read = await readReport(bucket, first.report_id);
  assert.equal(read.html, value.html);
  assert.equal(read.metadata.html_bytes, encoder.encode(value.html).byteLength);
  assert.match(read.metadata.html_sha256, /^[a-f0-9]{64}$/);
  assert.equal(read.metadata.repository_id, 1414200278);
  assert.equal(read.metadata.html, undefined);
  const listing = await listReports(bucket);
  assert.deepEqual(listing, { latest: read.metadata, reports: [read.metadata] });
  const version = bucket.sequence;
  assert.deepEqual(await publishReport(bucket, value), { status: 'unchanged', report_id: first.report_id });
  assert.equal(bucket.sequence, version, 'retry does not rewrite immutable HTML or index');
  const put = bucket.calls.find((call) => call.method === 'put' && call.key.endsWith('.html'));
  assert.equal(put.options.httpMetadata.cacheControl, 'private, no-store');
  assert.equal(put.options.httpMetadata.contentType, 'text/html; charset=utf-8');
});

test('same ID rejects changed HTML or metadata and preserves original index and object', async () => {
  const bucket = new MemoryBucket();
  await publishReport(bucket, payload());
  const snapshot = structuredClone([...bucket.objects]);
  for (const difference of [
    { html: '<html>different</html>' }, { code_sha: 'b'.repeat(40) },
    { data_through: '2026-10-09' }, { report_status: 'limited' },
  ]) {
    await assert.rejects(publishReport(bucket, payload(difference)), fixedError('VIEWER_REPORT_CONFLICT'));
    assert.deepEqual([...bucket.objects], snapshot);
  }
});

test('strict payload validation rejects malformed, foreign and excessive data before storage', async () => {
  const missingCutoff = payload();
  delete missingCutoff.data_through;
  const invalid = [null, [], {}, missingCutoff, payload({ extra: true }),
    payload({ schema_version: '1' }), payload({ repository: 'attacker/private' }),
    payload({ repository_id: '1414200278' }), payload({ repository_id: 1 }),
    payload({ report_date: '2026-02-30' }), payload({ report_date: '2026-2-01' }),
    payload({ report_date: '1999-12-31' }), payload({ report_date: '2100-01-01' }),
    payload({ data_through: undefined }), payload({ data_through: '2026-10-12' }),
    payload({ data_through: '2025-02-29' }), payload({ data_through: null }),
    payload({ report_status: 'failed' }), payload({ run_id: '' }),
    payload({ run_id: '../secret' }), payload({ run_id: 'a\u0000b' }),
    payload({ run_id: 'x'.repeat(101) }), payload({ run_id: 100 }),
    payload({ attempt: '1' }), payload({ attempt: 0 }), payload({ attempt: -1 }),
    payload({ attempt: 1.1 }), payload({ attempt: 1001 }), payload({ attempt: Infinity }),
    payload({ code_sha: 'a'.repeat(39) }), payload({ code_sha: 'g'.repeat(40) }),
    payload({ html: null }), payload({ html: '' }), payload({ html: '  \n' }),
    payload({ html: '\ud800' }),
  ];
  const bucket = new MemoryBucket();
  for (const value of invalid) await assert.rejects(publishReport(bucket, value), fixedError('VIEWER_INVALID_PAYLOAD'));
  await assert.rejects(publishReport(bucket, payload({ html: '中'.repeat(700_000) })), fixedError('VIEWER_HTML_TOO_LARGE'));
  assert.equal(bucket.calls.length, 0);
  await publishReport(bucket, payload({ html: 'x'.repeat(2 * 1024 * 1024) }));
  assert.equal((await readReport(bucket, '2026-10-11/100-1')).metadata.html_bytes, 2 * 1024 * 1024);
});

test('readReport only accepts canonical IDs and never interprets keys, URLs or traversal', async () => {
  const bucket = new MemoryBucket();
  for (const id of [null, '', 'https://example.test/a', '../metadata/index.json',
    'reports/2026-10-11/100-1.html', '2026-10-11/../100-1', '2026-10-11/100-01',
    '2026-10-11/100-1001', '2026-02-30/100-1', '2026-10-11/100-1?x=1',
    '2026-10-11%2F100-1', '2026-10-11/100-1\n', '2026-10-11/100-1/']) {
    await assert.rejects(readReport(bucket, id), fixedError('VIEWER_INVALID_REPORT_ID'));
  }
  assert.equal(bucket.calls.length, 0);
  const value = payload({ run_id: 'manual_run-123', attempt: 1000, report_date: '2024-02-29', data_through: '2024-02-28' });
  await publishReport(bucket, value);
  assert.equal((await readReport(bucket, '2024-02-29/manual_run-123-1000')).html, value.html);
});

test('latest advances only for a later report date without losing or regressing a known cutoff', async () => {
  const bucket = new MemoryBucket();
  await publishReport(bucket, payload({ data_through: null, report_status: 'limited' }));
  await publishReport(bucket, payload({ report_date: '2026-10-12', run_id: '101', data_through: null, report_status: 'limited' }));
  assert.equal((await listReports(bucket)).latest.report_id, '2026-10-12/101-1');
  await publishReport(bucket, payload({ report_date: '2026-10-13', run_id: '102', data_through: '2026-10-10' }));
  const promoted = (await listReports(bucket)).latest;
  for (const next of [
    { report_date: '2026-10-14', run_id: '103', data_through: null, report_status: 'limited' },
    { report_date: '2026-10-15', run_id: '104', data_through: '2026-10-09' },
    { report_date: '2026-10-13', run_id: '105', data_through: '2026-10-11' },
    { report_date: '2026-10-12', run_id: '106', data_through: '2026-10-11' },
  ]) {
    await publishReport(bucket, payload(next));
    assert.deepEqual((await listReports(bucket)).latest, promoted);
  }
  assert.equal((await listReports(bucket)).reports.length, 7, 'all valid uploads remain in history');
  await publishReport(bucket, payload({ report_date: '2026-10-16', run_id: '107', data_through: '2026-10-10' }));
  assert.equal((await listReports(bucket)).latest.report_id, '2026-10-16/107-1');
});

test('concurrent distinct publications merge via CAS without losing directory entries', async () => {
  const bucket = new MemoryBucket();
  const wait = barrier(3);
  bucket.onGet = async (key, object) => { if (key === INDEX && object === null) await wait(); };
  const values = [0, 1, 2].map((offset) => payload({ report_date: `2026-10-${11 + offset}`, run_id: `${100 + offset}` }));
  const results = await Promise.all(values.map((value) => publishReport(bucket, value)));
  assert.ok(results.every((result) => result.status === 'published'));
  const listing = await listReports(bucket);
  assert.deepEqual(listing.reports.map((report) => report.report_id), ['2026-10-13/102-1', '2026-10-12/101-1', '2026-10-11/100-1']);
  assert.equal(listing.latest.report_id, '2026-10-13/102-1');
  assert.ok(bucket.calls.filter((call) => call.method === 'put' && call.key === INDEX).length > 3);
});

test('concurrent duplicate uploads are idempotent, and a conflicting writer never changes content', async () => {
  const bucket = new MemoryBucket();
  const wait = barrier(2);
  bucket.onGet = async (key, object) => { if (key === INDEX && object === null) await wait(); };
  const results = await Promise.all([publishReport(bucket, payload()), publishReport(bucket, payload())]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['published', 'unchanged']);
  assert.equal((await listReports(bucket)).reports.length, 1);
  const collision = await Promise.allSettled([
    publishReport(bucket, payload()), publishReport(bucket, payload({ html: '<p>changed</p>' })),
  ]);
  assert.equal(collision[0].status, 'fulfilled');
  assert.equal(collision[1].status, 'rejected');
  assert.equal(collision[1].reason.code, 'VIEWER_REPORT_CONFLICT');
  assert.equal((await readReport(bucket, '2026-10-11/100-1')).html, payload().html);
});

test('three failed index conditions stop safely and a later retry repairs the index', async () => {
  const bucket = new MemoryBucket();
  bucket.onPut = async (key) => key === INDEX ? false : undefined;
  await assert.rejects(publishReport(bucket, payload()), fixedError('VIEWER_INDEX_CONFLICT'));
  assert.equal(bucket.calls.filter((call) => call.method === 'put' && call.key === INDEX).length, 3);
  assert.deepEqual(await listReports(bucket), { latest: null, reports: [] });
  assert.equal((await readReport(bucket, '2026-10-11/100-1')).html, payload().html);
  const immutableVersion = bucket.objects.get('reports/2026-10-11/100-1.html').etag;
  bucket.onPut = null;
  assert.equal((await publishReport(bucket, payload())).status, 'published');
  assert.equal(bucket.objects.get('reports/2026-10-11/100-1.html').etag, immutableVersion);
  assert.equal((await listReports(bucket)).reports.length, 1);
});

test('catalog keeps at most 365 newest reports while old HTML and a protected latest remain readable', async () => {
  const bucket = new MemoryBucket();
  const start = new Date('2024-01-01T00:00:00Z');
  await publishReport(bucket, payload({ report_date: '2024-01-01', data_through: '2024-01-01' }));
  for (let offset = 1; offset <= 365; offset += 1) {
    const date = new Date(start.valueOf() + offset * 86_400_000).toISOString().slice(0, 10);
    await publishReport(bucket, payload({ report_date: date, run_id: `${100 + offset}`, data_through: null, report_status: 'limited' }));
  }
  const listing = await listReports(bucket);
  assert.equal(listing.reports.length, 365);
  assert.equal(listing.reports[0].report_date, '2024-12-31');
  assert.equal(listing.reports.at(-1).report_date, '2024-01-02');
  assert.equal(listing.latest.report_date, '2024-01-01');
  assert.ok(await readReport(bucket, listing.latest.report_id));
  assert.equal((await publishReport(bucket, payload({ report_date: '2024-01-01', data_through: '2024-01-01' }))).status, 'unchanged');
  assert.equal((await listReports(bucket)).reports.length, 365);
});

test('storage and body-read exceptions are replaced by fixed errors without content or causes', async () => {
  const privateText = 'provider exception containing synthetic private report and token';
  const failure = async () => { throw new Error(privateText); };
  for (const operation of [
    () => listReports({ get: failure }),
    () => readReport({ get: failure }, '2026-10-11/100-1'),
    () => publishReport({ put: failure }, payload()),
    () => listReports({ get: async () => ({ size: 10, etag: 'ok', text: failure }) }),
  ]) await assert.rejects(operation(), fixedError('VIEWER_STORAGE_ERROR'));
});

test('corrupt index, metadata and HTML fail closed instead of returning unverified content', async () => {
  const corruptions = [
    (bucket) => { bucket.objects.get(INDEX).body = '{'; },
    (bucket) => { bucket.objects.get(INDEX).body = JSON.stringify({ schema_version: 1, latest: null, reports: [{}] }); },
    (bucket) => { const value = JSON.parse(bucket.objects.get(INDEX).body); value.reports.push(value.reports[0]); bucket.objects.get(INDEX).body = JSON.stringify(value); },
  ];
  for (const corrupt of corruptions) {
    const bucket = new MemoryBucket();
    await publishReport(bucket, payload());
    corrupt(bucket);
    await assert.rejects(listReports(bucket), fixedError('VIEWER_STORAGE_INVALID'));
  }
  for (const corruption of ['metadata', 'body']) {
    const bucket = new MemoryBucket();
    await publishReport(bucket, payload());
    const object = bucket.objects.get('reports/2026-10-11/100-1.html');
    if (corruption === 'metadata') object.customMetadata.report = '{}';
    else object.body = object.body.replace('body', 'xxxx');
    await assert.rejects(readReport(bucket, '2026-10-11/100-1'), fixedError('VIEWER_STORAGE_INVALID'));
  }
});
