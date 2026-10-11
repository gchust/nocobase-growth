import { createHash } from 'node:crypto';

const API_ORIGIN = 'https://api.github.com';
const REPOSITORY = 'gchust/nocobase-growth-reports';
const BRANCH = 'main';
const MAX_ATTEMPTS = 3;
const ALLOWED_FILES = new Set([
  'report.html', 'report.md', 'report.json', 'metrics.json', 'analysis.json', 'run.json',
]);
const REQUIRED_REPORT_FILES = ['report.html', 'report.md', 'report.json', 'metrics.json', 'analysis.json'];
const SHA = /^[0-9a-f]{40}$/;
const STATE_PATHS = ['state/summary.json', 'state/site-checks.json', 'state/latest.json'];

class ArchiveError extends Error {
  constructor(code, { status, retryable = false } = {}) {
    super(code);
    this.name = 'ArchiveError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.retryable = retryable;
  }
}

function fail(code, details) {
  throw new ArchiveError(code, details);
}

function safeError(error) {
  return error instanceof ArchiveError ? error : new ArchiveError('ARCHIVE_INTERNAL_ERROR');
}

function isRecord(value) {
  return value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!isRecord(value) && !Array.isArray(value)) || seen.has(value)) fail('ARCHIVE_INVALID_INPUT');
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => canonicalValue(item, seen))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key], seen)]));
  seen.delete(value);
  return result;
}

function json(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function context(options) {
  if (!isRecord(options) || options.repository !== REPOSITORY) fail('ARCHIVE_TARGET_MISMATCH');
  const id = String(options.repository_id ?? '');
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) fail('ARCHIVE_INVALID_REPOSITORY_ID');
  if (typeof options.token !== 'string' || options.token.length === 0 || /\s/.test(options.token)) {
    fail('ARCHIVE_CREDENTIAL_MISSING');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('ARCHIVE_INVALID_INPUT');
  return { repository_id: Number(id), token: options.token, fetchImpl };
}

async function retryDelay(response, attempt) {
  const header = response?.headers?.get('retry-after');
  const seconds = header === null || header === undefined ? NaN : Number(header);
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, 2000)
    : 100 * (2 ** attempt);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

// Only GET is retried here. Writes are retried as a transaction after probing the
// immutable run marker; no API error body or transport error escapes this module.
async function api(ctx, suffix = '', { method = 'GET', body } = {}) {
  const url = `${API_ORIGIN}/repos/${REPOSITORY}${suffix}`;
  const attempts = method === 'GET' ? MAX_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await ctx.fetchImpl(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${ctx.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      if (attempt + 1 < attempts) {
        await retryDelay(null, attempt);
        continue;
      }
      fail('ARCHIVE_API_UNAVAILABLE', { retryable: true });
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      fail('ARCHIVE_API_REDIRECT');
    }
    if (response.url) {
      let origin;
      try { origin = new URL(response.url).origin; } catch { fail('ARCHIVE_API_REDIRECT'); }
      if (origin !== API_ORIGIN) fail('ARCHIVE_API_REDIRECT');
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt + 1 < attempts) {
        await retryDelay(response, attempt);
        continue;
      }
      fail('ARCHIVE_API_UNAVAILABLE', { status: response.status, retryable: true });
    }
    if (response.status < 200 || response.status >= 300) {
      fail('ARCHIVE_API_REJECTED', { status: response.status });
    }
    try {
      return await response.json();
    } catch {
      if (attempt + 1 < attempts) {
        await retryDelay(response, attempt);
        continue;
      }
      fail('ARCHIVE_API_UNAVAILABLE', { retryable: true });
    }
  }
  fail('ARCHIVE_API_UNAVAILABLE');
}

async function verify(ctx) {
  let metadata;
  try {
    metadata = await api(ctx);
  } catch (error) {
    if (error instanceof ArchiveError && error.status === 404) fail('ARCHIVE_TARGET_NOT_FOUND');
    throw error;
  }
  if (!isRecord(metadata) || metadata.id !== ctx.repository_id || metadata.full_name !== REPOSITORY
      || metadata.name !== 'nocobase-growth-reports' || metadata.owner?.login !== 'gchust') {
    fail('ARCHIVE_TARGET_MISMATCH');
  }
  if (metadata.private !== true || metadata.visibility !== 'private') fail('ARCHIVE_TARGET_NOT_PRIVATE');
  if (metadata.archived !== false || metadata.disabled !== false) fail('ARCHIVE_TARGET_DISABLED');
  if (metadata.default_branch !== BRANCH) fail('ARCHIVE_BRANCH_MISMATCH');
  return {
    id: metadata.id,
    full_name: metadata.full_name,
    name: metadata.name,
    owner: { login: metadata.owner.login },
    private: true,
    visibility: 'private',
    archived: false,
    disabled: false,
    default_branch: BRANCH,
  };
}

/** Verify the fixed destination, including its immutable numeric repository ID. */
export async function verifyPrivateRepository(options) {
  try {
    return await verify(context(options));
  } catch (error) {
    throw safeError(error);
  }
}

async function snapshot(ctx) {
  const ref = await api(ctx, `/git/ref/heads/${BRANCH}`);
  if (ref?.ref !== `refs/heads/${BRANCH}` || ref.object?.type !== 'commit' || !SHA.test(ref.object?.sha ?? '')) {
    fail('ARCHIVE_STATE_INVALID');
  }
  const commit = await api(ctx, `/git/commits/${ref.object.sha}`);
  if (commit?.sha !== ref.object.sha || !SHA.test(commit.tree?.sha ?? '')) fail('ARCHIVE_STATE_INVALID');
  return { head: commit.sha, tree: commit.tree.sha, trees: new Map(), blobs: new Map() };
}

async function tree(ctx, view, sha) {
  if (!view.trees.has(sha)) {
    view.trees.set(sha, (async () => {
      const result = await api(ctx, `/git/trees/${sha}`);
      if (result?.sha !== sha || !Array.isArray(result.tree) || result.truncated !== false) {
        fail('ARCHIVE_STATE_INVALID');
      }
      return result.tree;
    })());
  }
  return view.trees.get(sha);
}

async function readJson(ctx, view, path) {
  const parts = path.split('/');
  let sha = view.tree;
  for (let index = 0; index < parts.length; index += 1) {
    const entries = await tree(ctx, view, sha);
    const matches = entries.filter((entry) => entry?.path === parts[index]);
    if (matches.length === 0) return null;
    if (matches.length !== 1 || !SHA.test(matches[0].sha ?? '')) fail('ARCHIVE_STATE_INVALID');
    const entry = matches[0];
    if (index < parts.length - 1) {
      if (entry.type !== 'tree' || entry.mode !== '040000') fail('ARCHIVE_STATE_INVALID');
      sha = entry.sha;
      continue;
    }
    if (entry.type !== 'blob' || entry.mode !== '100644') fail('ARCHIVE_STATE_INVALID');
    if (!view.blobs.has(entry.sha)) {
      view.blobs.set(entry.sha, (async () => {
        const blob = await api(ctx, `/git/blobs/${entry.sha}`);
        if (blob?.sha !== entry.sha || blob.encoding !== 'base64' || typeof blob.content !== 'string') {
          fail('ARCHIVE_STATE_INVALID');
        }
        const bytes = Buffer.from(blob.content, 'base64');
        const actualSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (actualSha !== entry.sha) fail('ARCHIVE_STATE_INVALID');
        let parsed;
        try {
          parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch { fail('ARCHIVE_STATE_INVALID'); }
        if (!isRecord(parsed)) fail('ARCHIVE_STATE_INVALID');
        return parsed;
      })());
    }
    return view.blobs.get(entry.sha);
  }
  fail('ARCHIVE_STATE_INVALID');
}

function reportReference(value) {
  return {
    report_date: value.report_date,
    data_through: value.data_through,
    run_id: value.run_id,
    attempt: value.attempt,
    code_sha: value.code_sha,
    run_path: value.run_path,
    report_path: value.report_path,
    report_url: value.report_url,
  };
}

function validateLatest(latest, ctx) {
  if (!isRecord(latest) || latest.schema_version !== 1 || latest.status !== 'completed'
      || latest.repository !== REPOSITORY || latest.repository_id !== ctx.repository_id
      || !validDate(latest.report_date) || !validDate(latest.data_through)
      || typeof latest.run_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(latest.run_id)
      || !Number.isSafeInteger(latest.attempt) || latest.attempt < 1 || !SHA.test(latest.code_sha ?? '')) {
    fail('ARCHIVE_STATE_INVALID');
  }
  const runPath = `runs/${latest.report_date}/${latest.run_id}-${latest.attempt}/`;
  if (latest.run_path !== runPath || latest.report_path !== `${runPath}report.html`
      || latest.report_url !== `https://github.com/${REPOSITORY}/blob/${BRANCH}/${runPath}report.html`) {
    fail('ARCHIVE_STATE_INVALID');
  }
}

async function previousState(ctx, view) {
  const [summary, site_checks, latest] = await Promise.all(STATE_PATHS.map((path) => readJson(ctx, view, path)));
  if (summary === null && site_checks === null && latest === null) return { summary, site_checks, latest };
  if (summary === null || site_checks === null || latest === null) fail('ARCHIVE_STATE_INVALID');
  validateLatest(latest, ctx);
  if (summary.data_through !== latest.data_through) fail('ARCHIVE_STATE_INVALID');
  return { summary, site_checks, latest };
}

/** Read all state files from one immutable commit, after destination verification. */
export async function readPreviousState(options) {
  try {
    const ctx = context(options);
    await verify(ctx);
    return await previousState(ctx, await snapshot(ctx));
  } catch (error) {
    throw safeError(error);
  }
}

function normalizeRun(options, ctx) {
  const { report_date, status, code_sha } = options;
  const run_id = String(options.run_id ?? '');
  const attemptText = String(options.attempt ?? '');
  if (!validDate(report_date) || !['completed', 'failed'].includes(status) || !SHA.test(code_sha ?? '')
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(run_id)
      || !/^[1-9]\d*$/.test(attemptText) || !Number.isSafeInteger(Number(attemptText))) {
    fail('ARCHIVE_INVALID_INPUT');
  }
  const attempt = Number(attemptText);
  if (!(options.files instanceof Map) && !isRecord(options.files)) fail('ARCHIVE_INVALID_INPUT');
  if (isRecord(options.files) && Reflect.ownKeys(options.files).some((key) => typeof key !== 'string')) {
    fail('ARCHIVE_INVALID_INPUT');
  }
  const files = new Map(options.files instanceof Map ? options.files : Object.entries(options.files));
  for (const [name, content] of files) {
    if (!ALLOWED_FILES.has(name) || typeof content !== 'string') fail('ARCHIVE_INVALID_FILE');
    if (name.endsWith('.json')) {
      let parsed;
      try { parsed = JSON.parse(content); } catch { fail('ARCHIVE_INVALID_FILE'); }
      if (!isRecord(parsed)) fail('ARCHIVE_INVALID_FILE');
    }
  }
  if (status === 'completed' && REQUIRED_REPORT_FILES.some((name) => !files.get(name)?.trim())) {
    fail('ARCHIVE_INCOMPLETE_RUN');
  }
  const state = options.state === undefined ? null : canonicalValue(options.state);
  if (state !== null && !isRecord(state)) fail('ARCHIVE_INVALID_INPUT');
  if (status === 'completed'
      && (!isRecord(state?.summary) || !isRecord(state?.site_checks) || !validDate(state.summary.data_through))) {
    fail('ARCHIVE_INCOMPLETE_RUN');
  }
  const data_through = validDate(state?.summary?.data_through) ? state.summary.data_through : null;
  const run_path = `runs/${report_date}/${run_id}-${attempt}/`;
  const digest = createHash('sha256').update(JSON.stringify(canonicalValue({
    schema_version: 1,
    repository: REPOSITORY,
    repository_id: ctx.repository_id,
    report_date,
    run_id,
    attempt,
    code_sha,
    status,
    files: Object.fromEntries(files),
    state,
  }))).digest('hex');
  return { report_date, run_id, attempt, code_sha, status, files, state, data_through, run_path, digest };
}

function existingResult(marker, view, run, ctx) {
  const archive = marker?.archive;
  if (!isRecord(archive) || archive.schema_version !== 1 || archive.input_digest !== run.digest
      || archive.repository !== REPOSITORY || archive.repository_id !== ctx.repository_id
      || archive.run_path !== run.run_path || typeof archive.latest_updated !== 'boolean'
      || marker.report_date !== run.report_date || marker.run_id !== run.run_id || marker.attempt !== run.attempt
      || marker.code_sha !== run.code_sha || marker.status !== run.status) {
    fail('ARCHIVE_RUN_CONFLICT');
  }
  // On an idempotent retry this can be a descendant commit that contains the run.
  return { commit_sha: view.head, run_path: run.run_path, latest_updated: archive.latest_updated };
}

function entriesForRun(run, ctx, previous) {
  const latestUpdated = run.status === 'completed'
    && (previous.latest === null || (run.report_date > previous.latest.report_date
      && run.data_through >= previous.latest.data_through));
  const priorReport = previous.latest === null ? null : reportReference(previous.latest);
  const suppliedRun = run.files.has('run.json') ? JSON.parse(run.files.get('run.json')) : {};
  const marker = {
    ...suppliedRun,
    status: run.status,
    report_date: run.report_date,
    run_id: run.run_id,
    attempt: run.attempt,
    code_sha: run.code_sha,
    archive: {
      schema_version: 1,
      repository: REPOSITORY,
      repository_id: ctx.repository_id,
      input_digest: run.digest,
      run_path: run.run_path,
      data_through: run.data_through,
      latest_updated: latestUpdated,
      previous_report: priorReport,
    },
  };
  const output = new Map(run.files);
  output.set('run.json', json(marker));
  const entries = [...output].map(([name, content]) => ({
    path: `${run.run_path}${name}`, mode: '100644', type: 'blob', content,
  }));
  if (latestUpdated) {
    const latest = {
      schema_version: 1,
      repository: REPOSITORY,
      repository_id: ctx.repository_id,
      status: 'completed',
      report_date: run.report_date,
      data_through: run.data_through,
      run_id: run.run_id,
      attempt: run.attempt,
      code_sha: run.code_sha,
      run_path: run.run_path,
      report_path: `${run.run_path}report.html`,
      report_url: `https://github.com/${REPOSITORY}/blob/${BRANCH}/${run.run_path}report.html`,
      previous_report: priorReport,
    };
    for (const [path, value] of [
      ['state/latest.json', latest],
      ['state/summary.json', run.state.summary],
      ['state/site-checks.json', run.state.site_checks],
    ]) entries.push({ path, mode: '100644', type: 'blob', content: json(value) });
  }
  return { entries, latestUpdated };
}

async function probeRun(ctx, run) {
  await verify(ctx);
  const view = await snapshot(ctx);
  const marker = await readJson(ctx, view, `${run.run_path}run.json`);
  return marker === null ? null : existingResult(marker, view, run, ctx);
}

/**
 * Atomically append one run with Git Data tree/commit/ref operations.
 * Completed runs require five report files and state: { summary, site_checks };
 * summary.data_through must be YYYY-MM-DD. run.json is generated if omitted.
 * Latest advances only for a strictly newer report_date with data_through >=
 * the existing cutoff. Failed runs and same-day retries never rewrite state.
 * Each GET and the write transaction have at most three attempts.
 */
export async function archiveRun(options) {
  try {
    const ctx = context(options);
    const run = normalizeRun(options, ctx);
    await verify(ctx);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let writeStarted = false;
      try {
        const view = await snapshot(ctx);
        const marker = await readJson(ctx, view, `${run.run_path}run.json`);
        if (marker !== null) return existingResult(marker, view, run, ctx);
        const previous = await previousState(ctx, view);
        const { entries, latestUpdated } = entriesForRun(run, ctx, previous);
        await verify(ctx);
        writeStarted = true;
        const newTree = await api(ctx, '/git/trees', {
          method: 'POST', body: { base_tree: view.tree, tree: entries },
        });
        if (!SHA.test(newTree?.sha ?? '')) fail('ARCHIVE_STATE_INVALID');
        const commit = await api(ctx, '/git/commits', {
          method: 'POST',
          body: {
            message: `Archive ${run.report_date} run ${run.run_id}-${run.attempt} (${run.status})`,
            tree: newTree.sha,
            parents: [view.head],
          },
        });
        if (!SHA.test(commit?.sha ?? '')) fail('ARCHIVE_STATE_INVALID');
        // Recheck immediately before making the new objects reachable as well.
        await verify(ctx);
        let updated;
        try {
          updated = await api(ctx, `/git/refs/heads/${BRANCH}`, {
            method: 'PATCH', body: { sha: commit.sha, force: false },
          });
        } catch (error) {
          if (error instanceof ArchiveError && [409, 422].includes(error.status)) {
            fail('ARCHIVE_REF_CONFLICT', { retryable: true });
          }
          throw error;
        }
        if (updated?.ref !== `refs/heads/${BRANCH}` || updated.object?.sha !== commit.sha) {
          fail('ARCHIVE_API_UNAVAILABLE', { retryable: true });
        }
        return { commit_sha: commit.sha, run_path: run.run_path, latest_updated: latestUpdated };
      } catch (error) {
        if (!(error instanceof ArchiveError) || !writeStarted || !error.retryable) throw error;
        const persisted = await probeRun(ctx, run);
        if (persisted !== null) return persisted;
        if (attempt + 1 === MAX_ATTEMPTS) fail('ARCHIVE_RETRY_EXHAUSTED');
      }
    }
    fail('ARCHIVE_RETRY_EXHAUSTED');
  } catch (error) {
    throw safeError(error);
  }
}
