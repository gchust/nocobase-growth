import { createHash } from 'node:crypto';
import { REPORTS_BRANCH, verifyPrivateRepository } from './archive.mjs';
import { loadConfig, SafeError, validDate } from './config.mjs';

const REPOSITORY = 'gchust/nocobase-growth-reports';
const REPOSITORY_ID = 1414200278;
const GITHUB = `https://api.github.com/repos/${REPOSITORY}`;
const VIEWER = 'https://nocobase-growth-reports.gong-ads.chatgpt.site';
const MAX_BYTES = 2 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const ATTEMPTS = 3;

class WebPublishError extends SafeError {}
const fail = (code) => { throw new WebPublishError(code); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const reportDate = (value) => validDate(value) && value >= '2000-01-01' && value <= '2099-12-31';
const cutoff = (value) => Object.hasOwn(value, 'data_through')
  && (value.data_through === null || reportDate(value.data_through));

function settings(env, fetchImpl) {
  if (!env || typeof fetchImpl !== 'function') fail('WEB_PUBLISH_CONFIG_INVALID');
  if (!env.REPORT_VIEWER_URL) fail('WEB_PUBLISH_VIEWER_URL_REQUIRED');
  // Exact origins avoid URL normalization, user-info, port and encoded-path bypasses.
  if (![VIEWER, `${VIEWER}/`].includes(env.REPORT_VIEWER_URL)) fail('WEB_PUBLISH_VIEWER_URL_INVALID');
  for (const [field, code] of [
    ['REPORT_VIEWER_TOKEN', 'WEB_PUBLISH_VIEWER_TOKEN_REQUIRED'],
    ['REPORTS_TOKEN', 'WEB_PUBLISH_REPORTS_TOKEN_REQUIRED'],
  ]) {
    if (typeof env[field] !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(env[field])) fail(code);
  }
  if (env.REPORT_VIEWER_TOKEN === env.REPORTS_TOKEN
      || /^(?:gh[pousr]_|github_pat_)/.test(env.REPORT_VIEWER_TOKEN)) {
    fail('WEB_PUBLISH_TOKEN_DESTINATION_INVALID');
  }
  return { fetchImpl, githubToken: env.REPORTS_TOKEN, viewerToken: env.REPORT_VIEWER_TOKEN };
}

async function pause(response, attempt) {
  const raw = response?.headers?.get('retry-after');
  const seconds = raw == null ? NaN : Number(raw);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 2000) : 100 * 2 ** attempt;
  if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function boundedJson(response, maxBytes) {
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    fail('WEB_PUBLISH_RESPONSE_TOO_LARGE');
  }
  if (!response.body?.getReader) fail('WEB_PUBLISH_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        fail('WEB_PUBLISH_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)));
    if (!record(value)) fail('WEB_PUBLISH_RESPONSE_INVALID');
    return value;
  } catch { fail('WEB_PUBLISH_RESPONSE_INVALID'); }
}

// All endpoints are constructed locally. Never follow API-supplied URLs or redirects.
// POST retries send exactly the same immutable report; the viewer rejects conflicts.
async function request(ctx, url, { body, maxBytes = 512 * 1024 } = {}) {
  const isViewer = url === `${VIEWER}/api/reports`;
  if (!isViewer && !url.startsWith(`${GITHUB}/`) && url !== GITHUB) fail('WEB_PUBLISH_DESTINATION_INVALID');
  const headers = isViewer ? {
    'Content-Type': 'application/json',
    'OAI-Sites-Authorization': `Bearer ${ctx.viewerToken}`,
  } : {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${ctx.githubToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await ctx.fetchImpl(url, {
        method: isViewer ? 'POST' : 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
        ...(isViewer ? { body } : {}),
      });
    } catch {
      if (attempt + 1 < ATTEMPTS) { await pause(null, attempt); continue; }
      fail('WEB_PUBLISH_TRANSPORT_UNAVAILABLE');
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)
        || (response.url && response.url !== url)) fail('WEB_PUBLISH_REDIRECT_REJECTED');
    if (response.status === 408 || response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      if (attempt + 1 < ATTEMPTS) { await pause(response, attempt); continue; }
      fail('WEB_PUBLISH_SERVICE_UNAVAILABLE');
    }
    if (response.status < 200 || response.status >= 300) fail('WEB_PUBLISH_REQUEST_REJECTED');
    try { return await boundedJson(response, maxBytes); } catch (error) {
      if (error instanceof WebPublishError) throw error;
      // A transport failure while reading a successful response is retryable;
      // invalid JSON, an oversized response and all validation errors are not.
      if (attempt + 1 < ATTEMPTS) { await pause(response, attempt); continue; }
      fail('WEB_PUBLISH_TRANSPORT_UNAVAILABLE');
    }
  }
  fail('WEB_PUBLISH_SERVICE_UNAVAILABLE');
}

async function verifyTarget(ctx) {
  const metadata = await request(ctx, GITHUB);
  // Reuse archive's exact immutable-ID/private/default-branch checks. Its fetch
  // adapter only supplies already bounded/validated JSON: there is no second
  // network request or nested retry loop and no provider exception can escape.
  try {
    await verifyPrivateRepository({
      repository: REPOSITORY, repository_id: REPOSITORY_ID, token: ctx.githubToken,
      fetchImpl: async () => ({ status: 200, redirected: false, json: async () => metadata }),
    });
  } catch { fail('WEB_PUBLISH_PRIVATE_REPOSITORY_INVALID'); }
}

async function snapshot(ctx) {
  const ref = await request(ctx, `${GITHUB}/git/ref/heads/${REPORTS_BRANCH}`);
  if (REPORTS_BRANCH !== 'develop' || ref.ref !== 'refs/heads/develop'
      || ref.object?.type !== 'commit' || !SHA.test(ref.object?.sha ?? '')) fail('WEB_PUBLISH_ARCHIVE_INVALID');
  const commit = await request(ctx, `${GITHUB}/git/commits/${ref.object.sha}`);
  if (commit.sha !== ref.object.sha || !SHA.test(commit.tree?.sha ?? '')) fail('WEB_PUBLISH_ARCHIVE_INVALID');
  return { root: commit.tree.sha, trees: new Map(), blobs: new Map() };
}

async function readBlob(ctx, view, path, limit) {
  let sha = view.root;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    if (!view.trees.has(sha)) {
      const tree = await request(ctx, `${GITHUB}/git/trees/${sha}`);
      if (tree.sha !== sha || tree.truncated !== false || !Array.isArray(tree.tree)) fail('WEB_PUBLISH_ARCHIVE_INVALID');
      view.trees.set(sha, tree.tree);
    }
    const entries = view.trees.get(sha).filter((entry) => entry?.path === parts[index]);
    if (entries.length !== 1 || !SHA.test(entries[0].sha ?? '')) fail('WEB_PUBLISH_ARCHIVE_INVALID');
    const entry = entries[0];
    if (index < parts.length - 1) {
      if (entry.type !== 'tree' || entry.mode !== '040000') fail('WEB_PUBLISH_ARCHIVE_INVALID');
      sha = entry.sha;
      continue;
    }
    if (entry.type !== 'blob' || entry.mode !== '100644') fail('WEB_PUBLISH_ARCHIVE_INVALID');
    if (!view.blobs.has(entry.sha)) {
      const blob = await request(ctx, `${GITHUB}/git/blobs/${entry.sha}`, { maxBytes: Math.ceil(limit * 1.5) + 8192 });
      if (blob.sha !== entry.sha || blob.encoding !== 'base64' || typeof blob.content !== 'string') fail('WEB_PUBLISH_ARCHIVE_INVALID');
      const base64 = blob.content.replace(/[\r\n]/g, '');
      if (/[^A-Za-z0-9+/=]/.test(base64)) fail('WEB_PUBLISH_ARCHIVE_INVALID');
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length > limit) fail('WEB_PUBLISH_REPORT_TOO_LARGE');
      if ((blob.size !== undefined && blob.size !== bytes.length) || bytes.toString('base64') !== base64
          || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha) {
        fail('WEB_PUBLISH_ARCHIVE_INVALID');
      }
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('WEB_PUBLISH_ARCHIVE_INVALID'); }
      view.blobs.set(entry.sha, content);
    }
    const content = view.blobs.get(entry.sha);
    if (Buffer.byteLength(content) > limit) fail('WEB_PUBLISH_REPORT_TOO_LARGE');
    return content;
  }
  fail('WEB_PUBLISH_ARCHIVE_INVALID');
}

async function readJson(ctx, view, path) {
  const content = await readBlob(ctx, view, path, 256 * 1024);
  try {
    const value = JSON.parse(content);
    if (!record(value)) fail('WEB_PUBLISH_ARCHIVE_INVALID');
    return value;
  } catch { fail('WEB_PUBLISH_ARCHIVE_INVALID'); }
}

function validateLatest(latest) {
  if (latest.schema_version !== 1 || latest.status !== 'completed' || latest.repository !== REPOSITORY
      || latest.repository_id !== REPOSITORY_ID || !reportDate(latest.report_date) || !cutoff(latest)
      || (latest.data_through !== null && latest.data_through > latest.report_date)
      || typeof latest.run_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(latest.run_id)
      || !Number.isSafeInteger(latest.attempt) || latest.attempt < 1 || latest.attempt > 1000
      || !SHA.test(latest.code_sha ?? '')) fail('WEB_PUBLISH_ARCHIVE_INVALID');
  const path = `runs/${latest.report_date}/${latest.run_id}-${latest.attempt}/`;
  if (latest.run_path !== path || latest.report_path !== `${path}report.html`
      || latest.report_url !== `https://github.com/${REPOSITORY}/blob/develop/${path}report.html`) {
    fail('WEB_PUBLISH_ARCHIVE_INVALID');
  }
}

function validateRun(run, latest) {
  if (run.status !== 'completed' || !['complete', 'limited'].includes(run.report_status)
      || !cutoff(run) || run.data_through !== latest.data_through
      || (run.data_through === null && run.report_status !== 'limited')
      || ['report_date', 'run_id', 'attempt', 'code_sha'].some((field) => run[field] !== latest[field])) {
    fail('WEB_PUBLISH_ARCHIVE_INVALID');
  }
  const archive = run.archive;
  if (!record(archive) || archive.schema_version !== 1 || archive.repository !== REPOSITORY
      || archive.repository_id !== REPOSITORY_ID || archive.run_path !== latest.run_path
      || !cutoff(archive) || archive.data_through !== latest.data_through || archive.latest_updated !== true
      || !/^[0-9a-f]{64}$/.test(archive.input_digest ?? '')) fail('WEB_PUBLISH_ARCHIVE_INVALID');
}

/** Publish only verified private latest HTML. Return a fixed public-safe status. */
export async function publishWebReport({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  try {
    const ctx = settings(env, fetchImpl);
    const config = await loadConfig(new URL('../sites/nocobase.json', import.meta.url), { env: {} });
    if (config.archive.repository !== REPOSITORY || config.archive.repository_id !== REPOSITORY_ID) fail('WEB_PUBLISH_CONFIG_INVALID');
    await verifyTarget(ctx);
    const view = await snapshot(ctx);
    const latest = await readJson(ctx, view, 'state/latest.json');
    validateLatest(latest);
    const run = await readJson(ctx, view, `${latest.run_path}run.json`);
    validateRun(run, latest);
    const html = await readBlob(ctx, view, latest.report_path, MAX_BYTES);
    if (!html.trim()) fail('WEB_PUBLISH_ARCHIVE_INVALID');
    const body = JSON.stringify({
      schema_version: 1, repository: REPOSITORY, repository_id: REPOSITORY_ID,
      report_date: latest.report_date, run_id: latest.run_id, attempt: latest.attempt,
      code_sha: latest.code_sha, data_through: latest.data_through, report_status: run.report_status, html,
    });
    if (Buffer.byteLength(body) > MAX_BYTES) fail('WEB_PUBLISH_REPORT_TOO_LARGE');
    await verifyTarget(ctx);
    const result = await request(ctx, `${VIEWER}/api/reports`, { body, maxBytes: 8192 });
    if (!['published', 'unchanged'].includes(result.status)) fail('WEB_PUBLISH_RESPONSE_INVALID');
    return { status: result.status };
  } catch (error) {
    if (error instanceof WebPublishError) throw error;
    fail('WEB_PUBLISH_FAILED');
  }
}
