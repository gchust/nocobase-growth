import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { archiveRun, readPreviousState, verifyPrivateRepository } from '../src/archive.mjs';

const REPOSITORY = 'gchust/nocobase-growth-reports';
const REPOSITORY_ID = 123456;
const CODE_SHA = 'a'.repeat(40);
const sha = (value) => createHash('sha1').update(value).digest('hex');
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

// A small Git object store, including fast-forward rules and immutable snapshots.
// It permits real competing archive transactions and lost-response simulations.
function github() {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const calls = [];
  const server = {
    metadata: {
      id: REPOSITORY_ID, full_name: REPOSITORY, name: 'nocobase-growth-reports',
      owner: { login: 'gchust' }, private: true, visibility: 'private', archived: false,
      disabled: false, default_branch: 'main',
    },
    metadataStatus: 200,
    metadataResponses: [],
    beforePatch: null,
    loseNextTreeResponse: false,
    loseNextPatchResponse: false,
    metadataHook: null,
    metadataReads: 0,
    calls,
    head: null,
  };
  const blob = (content) => {
    const bytes = Buffer.from(content);
    const id = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    blobs.set(id, content);
    return id;
  };
  const makeTree = (files) => {
    const root = new Map();
    for (const [path, content] of files) {
      const parts = path.split('/');
      let current = root;
      for (const part of parts.slice(0, -1)) {
        if (!current.has(part)) current.set(part, new Map());
        current = current.get(part);
      }
      current.set(parts.at(-1), content);
    }
    const save = (items) => {
      const entries = [...items].sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => (
        value instanceof Map
          ? { path, mode: '040000', type: 'tree', sha: save(value) }
          : { path, mode: '100644', type: 'blob', sha: blob(value) }
      ));
      const id = sha(JSON.stringify(entries));
      trees.set(id, entries);
      return id;
    };
    return save(root);
  };
  const flatten = (id, prefix = '', out = new Map()) => {
    for (const entry of trees.get(id)) {
      if (entry.type === 'tree') flatten(entry.sha, `${prefix}${entry.path}/`, out);
      else out.set(`${prefix}${entry.path}`, blobs.get(entry.sha));
    }
    return out;
  };
  const commit = (tree, parents, message) => {
    const id = sha(JSON.stringify({ tree, parents, message }));
    commits.set(id, { sha: id, tree: { sha: tree }, parents: parents.map((parent) => ({ sha: parent })) });
    return id;
  };
  server.head = commit(makeTree(new Map([['README.md', '# Private reports\n']])), [], 'Initialize');
  server.files = () => flatten(commits.get(server.head).tree.sha);
  server.json = (path) => {
    const raw = server.files().get(path);
    return raw === undefined ? null : JSON.parse(raw);
  };
  server.append = (files) => {
    const next = server.files();
    for (const [path, content] of Object.entries(files)) next.set(path, content);
    server.head = commit(makeTree(next), [server.head], 'Concurrent update');
  };
  server.fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(parsed.search, '');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    const prefix = `/repos/${REPOSITORY}`;
    assert.ok(parsed.pathname.startsWith(prefix));
    const path = parsed.pathname.slice(prefix.length);
    const method = init.method;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method, path, body });
    if (method === 'GET' && path === '') {
      server.metadataReads += 1;
      if (server.metadataHook) await server.metadataHook(server.metadataReads);
      if (server.metadataResponses.length > 0) return server.metadataResponses.shift();
      return response(server.metadata, server.metadataStatus);
    }
    if (method === 'GET' && path === '/git/ref/heads/main') {
      return response({ ref: 'refs/heads/main', object: { type: 'commit', sha: server.head } });
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) {
      return response(commits.get(path.split('/').at(-1)));
    }
    if (method === 'GET' && path.startsWith('/git/trees/')) {
      const id = path.split('/').at(-1);
      return response({ sha: id, truncated: false, tree: trees.get(id) });
    }
    if (method === 'GET' && path.startsWith('/git/blobs/')) {
      const id = path.split('/').at(-1);
      const content = blobs.get(id);
      return response({ sha: id, encoding: 'base64', content: Buffer.from(content).toString('base64') });
    }
    if (method === 'POST' && path === '/git/trees') {
      const next = flatten(body.base_tree);
      for (const entry of body.tree) {
        assert.equal(entry.mode, '100644');
        assert.equal(entry.type, 'blob');
        assert.equal(typeof entry.content, 'string');
        next.set(entry.path, entry.content);
      }
      const id = makeTree(next);
      if (server.loseNextTreeResponse) {
        server.loseNextTreeResponse = false;
        throw new Error('Tree created, response lost with private remote details');
      }
      return response({ sha: id }, 201);
    }
    if (method === 'POST' && path === '/git/commits') {
      return response({ sha: commit(body.tree, body.parents, body.message) }, 201);
    }
    if (method === 'PATCH' && path === '/git/refs/heads/main') {
      assert.equal(body.force, false);
      if (server.beforePatch) await server.beforePatch();
      if (commits.get(body.sha).parents[0]?.sha !== server.head) {
        return response({ message: 'Remote private details must never be returned' }, 422);
      }
      server.head = body.sha;
      if (server.loseNextPatchResponse) {
        server.loseNextPatchResponse = false;
        throw new Error('Transport failed after publishing private report contents and test-token');
      }
      return response({ ref: 'refs/heads/main', object: { type: 'commit', sha: server.head } });
    }
    return response({ message: 'Not found' }, 404);
  };
  return server;
}

function options(server) {
  return { repository: REPOSITORY, repository_id: REPOSITORY_ID, token: 'test-token', fetchImpl: server.fetchImpl };
}

function run(server, overrides = {}) {
  const value = {
    ...options(server), report_date: '2026-10-11', run_id: '100', attempt: 1,
    code_sha: CODE_SHA, status: 'completed',
    files: {
      'report.html': '<!doctype html><title>Growth report</title><h1>Report</h1>',
      'report.md': '# Growth report\n',
      'report.json': '{"title":"Growth report"}',
      'metrics.json': '{"clicks":42}',
      'analysis.json': '{"findings":[]}',
      'run.json': '{"status":"completed","error_code":null}',
    },
    state: { summary: { data_through: '2026-10-08', clicks: 42 }, site_checks: { pages: [] } },
    ...overrides,
  };
  return value;
}

function errorCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes('test-token'));
    return true;
  };
}

test('fixed destination verification rejects public, unavailable, mismatched and inactive targets without writes', async (t) => {
  const cases = [
    ['public', { private: false, visibility: 'public' }, 'ARCHIVE_TARGET_NOT_PRIVATE'],
    ['visibility mismatch', { visibility: 'public' }, 'ARCHIVE_TARGET_NOT_PRIVATE'],
    ['wrong id', { id: REPOSITORY_ID + 1 }, 'ARCHIVE_TARGET_MISMATCH'],
    ['wrong owner', { owner: { login: 'someone-else' } }, 'ARCHIVE_TARGET_MISMATCH'],
    ['archived', { archived: true }, 'ARCHIVE_TARGET_DISABLED'],
    ['disabled', { disabled: true }, 'ARCHIVE_TARGET_DISABLED'],
    ['wrong branch', { default_branch: 'develop' }, 'ARCHIVE_BRANCH_MISMATCH'],
  ];
  for (const [name, metadata, code] of cases) {
    await t.test(name, async () => {
      const server = github();
      Object.assign(server.metadata, metadata);
      await assert.rejects(archiveRun(run(server)), errorCode(code));
      assert.equal(server.calls.filter((call) => call.method !== 'GET').length, 0);
    });
  }
  const missing = github();
  missing.metadataStatus = 404;
  await assert.rejects(verifyPrivateRepository(options(missing)), errorCode('ARCHIVE_TARGET_NOT_FOUND'));
  assert.equal(missing.calls.length, 1);
  const renamed = github();
  await assert.rejects(archiveRun(run(renamed, { repository: 'elsewhere/reports' })), errorCode('ARCHIVE_TARGET_MISMATCH'));
  assert.equal(renamed.calls.length, 0);
});

test('complete run atomically archives allowlisted files and reads consistent prior state', async () => {
  const server = github();
  assert.equal((await verifyPrivateRepository(options(server))).id, REPOSITORY_ID);
  assert.deepEqual(await readPreviousState(options(server)), { summary: null, site_checks: null, latest: null });
  const input = run(server, { files: new Map(Object.entries(run(server).files)) });
  const result = await archiveRun(input);
  assert.equal(result.run_path, 'runs/2026-10-11/100-1/');
  assert.equal(result.commit_sha, server.head);
  assert.equal(result.latest_updated, true);
  const state = await readPreviousState(options(server));
  assert.deepEqual(state.summary, input.state.summary);
  assert.deepEqual(state.site_checks, input.state.site_checks);
  assert.equal(state.latest.data_through, '2026-10-08');
  assert.equal(state.latest.report_path, `${result.run_path}report.html`);
  assert.equal(state.latest.report_url, `https://github.com/${REPOSITORY}/blob/main/${result.run_path}report.html`);
  assert.equal(state.latest.previous_report, null);
  const marker = server.json(`${result.run_path}run.json`);
  assert.match(marker.archive.input_digest, /^[0-9a-f]{64}$/);
  assert.equal(marker.archive.latest_updated, true);
  assert.equal(server.files().get('README.md'), '# Private reports\n');
  assert.deepEqual([...server.files().keys()].sort(), [
    'README.md', ...[...input.files.keys()].map((name) => `${result.run_path}${name}`),
    'state/latest.json', 'state/summary.json', 'state/site-checks.json',
  ].sort());
  assert.equal(server.calls.filter((call) => call.method === 'PATCH').length, 1);
});

test('failure is retained with a generated run marker and never advances latest or summary', async () => {
  const server = github();
  const failed = await archiveRun(run(server, { status: 'failed', files: {}, state: undefined }));
  assert.equal(failed.latest_updated, false);
  assert.equal(server.json(`${failed.run_path}run.json`).status, 'failed');
  assert.deepEqual(await readPreviousState(options(server)), { summary: null, site_checks: null, latest: null });
  await archiveRun(run(server, { run_id: '101' }));
  const before = await readPreviousState(options(server));
  const laterFailure = await archiveRun(run(server, {
    report_date: '2026-10-12', run_id: '102', status: 'failed',
    files: { 'run.json': '{"error_code":"SOURCE_UNAVAILABLE"}' }, state: undefined,
  }));
  assert.equal(laterFailure.latest_updated, false);
  assert.deepEqual(await readPreviousState(options(server)), before);
  assert.equal(server.json(`${laterFailure.run_path}run.json`).error_code, 'SOURCE_UNAVAILABLE');
});

test('old backfills, same-day reruns and stale data cannot displace current state', async () => {
  const server = github();
  const first = await archiveRun(run(server));
  const before = await readPreviousState(options(server));
  for (const input of [
    run(server, { report_date: '2026-10-10', run_id: '101' }),
    run(server, { run_id: '102', state: { summary: { data_through: '2026-10-09' }, site_checks: {} } }),
    run(server, { report_date: '2026-10-12', run_id: '103', state: { summary: { data_through: '2026-10-07' }, site_checks: {} } }),
  ]) {
    const result = await archiveRun(input);
    assert.equal(result.latest_updated, false);
    assert.ok(server.files().has(`${result.run_path}report.html`));
    assert.deepEqual(await readPreviousState(options(server)), before);
  }
  const newer = await archiveRun(run(server, { report_date: '2026-10-12', run_id: '104' }));
  assert.equal(newer.latest_updated, true);
  const state = await readPreviousState(options(server));
  assert.equal(state.latest.previous_report.run_path, first.run_path);
  assert.equal(state.latest.previous_report.report_url, before.latest.report_url);
  assert.equal(state.latest.previous_report.previous_report, undefined);
});

test('a competing newer run survives an optimistic write conflict without losing either archive', async () => {
  const server = github();
  let concurrent;
  server.beforePatch = async () => {
    server.beforePatch = null;
    concurrent = await archiveRun(run(server, {
      report_date: '2026-10-12', run_id: '101',
      state: { summary: { data_through: '2026-10-09', clicks: 84 }, site_checks: { pages: ['new'] } },
    }));
  };
  const older = await archiveRun(run(server));
  assert.equal(older.latest_updated, false);
  assert.equal(concurrent.latest_updated, true);
  assert.ok(server.files().has(`${older.run_path}report.html`));
  assert.ok(server.files().has(`${concurrent.run_path}report.html`));
  const state = await readPreviousState(options(server));
  assert.equal(state.latest.run_id, '101');
  assert.equal(state.summary.clicks, 84);
  assert.equal(server.calls.filter((call) => call.method === 'PATCH').length, 3);
});

test('lost ref response is recovered by the marker, retries are idempotent, changed payload is rejected', async () => {
  const server = github();
  const input = run(server);
  server.loseNextPatchResponse = true;
  const first = await archiveRun(input);
  assert.equal(first.latest_updated, true);
  const writes = server.calls.filter((call) => call.method !== 'GET').length;
  assert.deepEqual(await archiveRun(input), first);
  assert.equal(server.calls.filter((call) => call.method !== 'GET').length, writes);
  await assert.rejects(archiveRun(run(server, {
    files: { ...input.files, 'metrics.json': '{"clicks":999}' },
  })), errorCode('ARCHIVE_RUN_CONFLICT'));
  assert.equal(server.calls.filter((call) => call.method !== 'GET').length, writes);
});

test('privacy is rechecked before object writes and again before the branch update', async (t) => {
  for (const flipAt of [2, 3]) {
    await t.test(`visibility changes at verification ${flipAt}`, async () => {
      const server = github();
      server.metadataHook = (reads) => {
        if (reads === flipAt) Object.assign(server.metadata, { private: false, visibility: 'public' });
      };
      const originalHead = server.head;
      await assert.rejects(archiveRun(run(server)), errorCode('ARCHIVE_TARGET_NOT_PRIVATE'));
      assert.equal(server.head, originalHead);
      assert.equal(server.calls.filter((call) => call.method === 'PATCH').length, 0);
      if (flipAt === 2) assert.equal(server.calls.filter((call) => call.method === 'POST').length, 0);
    });
  }
});

test('a lost tree response triggers a marker probe before retrying the transaction', async () => {
  const server = github();
  server.loseNextTreeResponse = true;
  const result = await archiveRun(run(server));
  assert.equal(result.latest_updated, true);
  const treeWrites = server.calls.flatMap((call, index) => call.method === 'POST' && call.path === '/git/trees' ? [index] : []);
  assert.equal(treeWrites.length, 2);
  const betweenWrites = server.calls.slice(treeWrites[0] + 1, treeWrites[1]);
  assert.ok(betweenWrites.some((call) => call.method === 'GET' && call.path === '/git/ref/heads/main'));
  assert.ok(betweenWrites.some((call) => call.method === 'GET' && call.path.startsWith('/git/trees/')));
  assert.equal(server.calls.filter((call) => call.method === 'PATCH').length, 1);
  assert.equal(server.json('state/latest.json').run_id, '100');
});

test('retry bounds apply to GET throttling and repeated branch conflicts', async () => {
  const limited = github();
  limited.metadataResponses = [429, 503, 503].map((status) => response({ message: 'Private response' }, status, { 'retry-after': '0' }));
  await assert.rejects(verifyPrivateRepository(options(limited)), errorCode('ARCHIVE_API_UNAVAILABLE'));
  assert.equal(limited.calls.length, 3);
  const busy = github();
  let competingWrites = 0;
  busy.beforePatch = () => {
    competingWrites += 1;
    busy.append({ 'README.md': `# Concurrent revision ${competingWrites}\n` });
  };
  await assert.rejects(archiveRun(run(busy)), errorCode('ARCHIVE_RETRY_EXHAUSTED'));
  assert.equal(busy.calls.filter((call) => call.method === 'PATCH').length, 3);
  assert.equal(busy.json('state/latest.json'), null);
  assert.equal(busy.files().get('README.md'), '# Concurrent revision 3\n');
});

test('redirects, arbitrary filenames and incomplete successful runs fail closed', async () => {
  const redirected = github();
  redirected.metadataResponses = [response({}, 301, { location: 'https://elsewhere.invalid/private' })];
  await assert.rejects(verifyPrivateRepository(options(redirected)), errorCode('ARCHIVE_API_REDIRECT'));
  const server = github();
  for (const filename of ['../report.html', 'logs.txt', '.env', 'nested/report.json']) {
    await assert.rejects(archiveRun(run(server, { files: { [filename]: 'private' } })), errorCode('ARCHIVE_INVALID_FILE'));
  }
  await assert.rejects(archiveRun(run(server, { files: { 'run.json': '{}' } })), errorCode('ARCHIVE_INCOMPLETE_RUN'));
  await assert.rejects(archiveRun(run(server, { state: { summary: {}, site_checks: {} } })), errorCode('ARCHIVE_INCOMPLETE_RUN'));
  assert.equal(server.calls.length, 0);
});
