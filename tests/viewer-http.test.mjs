import test from 'node:test';
import assert from 'node:assert/strict';
import { reportsEndpoint, reportEndpoint } from '../viewer/server/http.mjs';

const ORIGIN = 'https://reports.example.test';
const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
const encoder = new TextEncoder();

function fixture(overrides = {}) {
  return { schema_version: 1, repository: 'gchust/nocobase-growth-reports', repository_id: 1414200278,
    report_date: '2026-10-11', run_id: '100', attempt: 1, code_sha: 'a'.repeat(40),
    data_through: null, report_status: 'limited', html: '<!doctype html><html lang="zh-CN"><title>合成日报</title><style>body{color:#123}</style><body>测试</body></html>',
    ...overrides };
}

function request(path = '/api/reports', options = {}) {
  return new Request(`${ORIGIN}${path}`, options);
}

function upload(value = fixture(), headers = {}) {
  return request('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
}

function bucket() {
  const objects = new Map();
  const calls = [];
  let version = 0;
  const snapshot = (key) => {
    const object = objects.get(key);
    return object ? { ...object, text: async () => object.textValue } : null;
  };
  return {
    calls,
    async get(key) { calls.push(['get', key]); return snapshot(key); },
    async put(key, value, options) {
      calls.push(['put', key]);
      const current = objects.get(key);
      if (options.onlyIf instanceof Headers) {
        if (current) return null;
      } else if (current?.etag !== options.onlyIf.etagMatches) return null;
      const textValue = typeof value === 'string' ? value : new TextDecoder().decode(value);
      objects.set(key, { textValue, size: encoder.encode(textValue).byteLength, etag: `v${++version}`,
        customMetadata: options.customMetadata ?? {} });
      return snapshot(key);
    },
  };
}

function assertPrivate(response) {
  assert.match(response.headers.get('Cache-Control'), /private.*no-store/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('X-Robots-Tag'), /noindex.*noarchive/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
}

test('HTTP upload, list, immutable retry, view and download use the report-store contract', async () => {
  const store = bucket();
  const published = await reportsEndpoint(upload(fixture(), { Origin: ORIGIN }), store);
  assert.equal(published.status, 200);
  assertPrivate(published);
  assert.deepEqual(await published.json(), { status: 'published', report_id: '2026-10-11/100-1' });
  assert.equal((await (await reportsEndpoint(upload(), store)).json()).status, 'unchanged');
  const index = await reportsEndpoint(request(), store);
  assertPrivate(index);
  const listing = await index.json();
  assert.equal(listing.latest.report_id, '2026-10-11/100-1');
  assert.equal(listing.reports.length, 1);
  assert.equal(listing.latest.html, undefined);
  const html = await reportEndpoint(request('/reports/2026-10-11/100-1'), store, listing.latest.report_id);
  assert.equal(html.status, 200);
  assertPrivate(html);
  assert.equal(html.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(await html.text(), fixture().html);
  const csp = html.headers.get('Content-Security-Policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /(?:^|;) sandbox(?: |$)/);
  assert.doesNotMatch(csp, /allow-scripts|allow-same-origin|allow-forms|allow-top-navigation/);
  const download = await reportEndpoint(request('/reports/2026-10-11/100-1?download=1'), store, listing.latest.report_id);
  assert.equal(download.headers.get('Content-Disposition'), 'attachment; filename="nocobase-report-2026-10-11.html"');
  assert.equal(download.headers.get('Content-Security-Policy'), csp);
});

test('origin, content type, method and malformed payload failures do not reach storage', async () => {
  const store = bucket();
  const cases = [
    [upload(fixture(), { Origin: 'https://attacker.example' }), 403, 'VIEWER_ORIGIN_REJECTED'],
    [upload(fixture(), { Origin: 'null' }), 403, 'VIEWER_ORIGIN_REJECTED'],
    [upload(fixture(), { 'Content-Type': 'text/plain' }), 415, 'VIEWER_CONTENT_TYPE_REJECTED'],
    [upload(fixture(), { 'Content-Type': 'application/jsonp' }), 415, 'VIEWER_CONTENT_TYPE_REJECTED'],
    [request('/api/reports', { method: 'DELETE' }), 405, 'VIEWER_METHOD_NOT_ALLOWED'],
    [upload({ ...fixture(), html: 'synthetic-private-marker', unexpected_secret: 'do-not-echo' }), 400, 'VIEWER_INVALID_PAYLOAD'],
    [request('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{private-invalid-json' }), 400, 'VIEWER_INVALID_REQUEST'],
  ];
  for (const [input, status, code] of cases) {
    const response = await reportsEndpoint(input, store);
    assert.equal(response.status, status);
    assertPrivate(response);
    assert.deepEqual(await response.json(), { error: { code } });
  }
  assert.equal(store.calls.length, 0);
});

test('request limit counts streamed bytes even with a false content-length', async () => {
  const store = bucket();
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { cancelled = true; },
  });
  const streamed = request('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1' }, body: stream, duplex: 'half' });
  for (const input of [upload(fixture(), { 'Content-Length': String(MAX_REQUEST_BYTES + 1) }), streamed]) {
    const response = await reportsEndpoint(input, store);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: { code: 'VIEWER_REQUEST_TOO_LARGE' } });
  }
  assert.equal(cancelled, true);
  assert.equal(store.calls.length, 0);
});

test('invalid UTF-8, empty input and broken request streams return fixed 400 errors', async () => {
  const store = bucket();
  const invalid = [new Uint8Array([0xc3, 0x28]), '', new ReadableStream({
    pull(controller) { controller.error(new Error('synthetic private stream failure')); },
  })];
  for (const body of invalid) {
    const response = await reportsEndpoint(request('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' }), store);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: 'VIEWER_INVALID_REQUEST' } });
  }
  assert.equal(store.calls.length, 0);
});

test('missing storage, underlying exceptions, conflict and invalid IDs return only fixed codes', async () => {
  const unavailable = { async get() { throw new Error('secret raw R2 error: synthetic-private-token'); } };
  for (const [input, expected] of [
    [reportsEndpoint(request(), null), 'VIEWER_UNAVAILABLE'],
    [reportsEndpoint(request(), unavailable), 'VIEWER_STORAGE_ERROR'],
    [reportEndpoint(request('/reports/x/y'), unavailable, '2026-10-11/100-1'), 'VIEWER_STORAGE_ERROR'],
  ]) {
    const response = await input;
    assert.equal(response.status, 503);
    assertPrivate(response);
    assert.deepEqual(await response.json(), { error: { code: expected } });
  }
  const store = bucket();
  const traversal = await reportEndpoint(request('/reports/x/y'), store, '../metadata/index.json');
  assert.equal(traversal.status, 400);
  assert.deepEqual(await traversal.json(), { error: { code: 'VIEWER_INVALID_REPORT_ID' } });
  assert.equal(store.calls.length, 0);
  await reportsEndpoint(upload(), store);
  const conflict = await reportsEndpoint(upload(fixture({ html: '<p>different private body</p>' })), store);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: { code: 'VIEWER_REPORT_CONFLICT' } });
});

test('HEAD responses are bodyless for success, missing report, invalid ID and unavailable storage', async () => {
  const store = bucket();
  await reportsEndpoint(upload(), store);
  const head = request('/reports/2026-10-11/100-1', { method: 'HEAD' });
  for (const [target, id, status] of [
    [store, '2026-10-11/100-1', 200], [store, '2026-10-11/999-1', 404],
    [store, '../secret', 400], [null, '2026-10-11/100-1', 503],
    [{ async get() { throw new Error('private'); } }, '2026-10-11/100-1', 503],
  ]) {
    const response = await reportEndpoint(head, target, id);
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(await response.text(), '');
    assertPrivate(response);
  }
});
