import { ReportStoreError, publishReport, listReports, readReport } from './report-store.mjs';

const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'Referrer-Policy': 'no-referrer',
};

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), { status,
    headers: { ...PRIVATE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}

function failure(error) {
  if (!(error instanceof ReportStoreError)) return json({ error: { code: 'VIEWER_UNAVAILABLE' } }, 503);
  const statuses = { VIEWER_INVALID_PAYLOAD: 400, VIEWER_HTML_TOO_LARGE: 413,
    VIEWER_INVALID_REPORT_ID: 400, VIEWER_REPORT_CONFLICT: 409,
    VIEWER_INDEX_CONFLICT: 503, VIEWER_STORAGE_ERROR: 503, VIEWER_STORAGE_INVALID: 503 };
  const status = statuses[error.code];
  return json({ error: { code: status ? error.code : 'VIEWER_UNAVAILABLE' } }, status || 503);
}

async function boundedJson(request) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
    return { error: json({ error: { code: 'VIEWER_REQUEST_TOO_LARGE' } }, 413) };
  }
  if (!request.body) return { error: json({ error: { code: 'VIEWER_INVALID_REQUEST' } }, 400) };
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return { error: json({ error: { code: 'VIEWER_REQUEST_TOO_LARGE' } }, 413) };
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) };
  } catch {
    return { error: json({ error: { code: 'VIEWER_INVALID_REQUEST' } }, 400) };
  } finally { reader.releaseLock(); }
}

// Hosted only as an owner-private Site. Sites dispatch authenticates the viewer
// or consumes its Site-scoped service credential before invoking this handler.
// The app does not receive or store the GitHub or model credentials.
export async function reportsEndpoint(request, bucket) {
  if (!bucket) return json({ error: { code: 'VIEWER_UNAVAILABLE' } }, 503);
  try {
    if (request.method === 'GET') return json(await listReports(bucket));
    if (request.method !== 'POST') return json({ error: { code: 'VIEWER_METHOD_NOT_ALLOWED' } }, 405, { Allow: 'GET, POST' });
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== new URL(request.url).origin) {
      return json({ error: { code: 'VIEWER_ORIGIN_REJECTED' } }, 403);
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) {
      return json({ error: { code: 'VIEWER_CONTENT_TYPE_REJECTED' } }, 415);
    }
    const body = await boundedJson(request);
    if (body.error) return body.error;
    return json(await publishReport(bucket, body.value));
  } catch (error) { return failure(error); }
}

export async function reportEndpoint(request, bucket, reportId) {
  // HEAD errors must be bodyless too, including when this handler is invoked
  // directly instead of through a framework that strips response bodies.
  const respond = (response) => request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers }) : response;
  if (!bucket) return respond(json({ error: { code: 'VIEWER_UNAVAILABLE' } }, 503));
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: { code: 'VIEWER_METHOD_NOT_ALLOWED' } }, 405, { Allow: 'GET, HEAD' });
  try {
    const report = await readReport(bucket, reportId);
    if (!report) return respond(json({ error: { code: 'VIEWER_NOT_FOUND' } }, 404));
    const download = new URL(request.url).searchParams.get('download') === '1';
    return new Response(request.method === 'HEAD' ? null : report.html, {
      headers: { ...PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox",
        ...(download ? { 'Content-Disposition': `attachment; filename="nocobase-report-${report.metadata.report_date}.html"` } : {}),
      },
    });
  } catch (error) { return respond(failure(error)); }
}
