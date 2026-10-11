import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { publishWebReport } from '../src/web-publish.mjs';

const REPO = 'gchust/nocobase-growth-reports';
const REPO_ID = 1414200278;
const GITHUB = `https://api.github.com/repos/${REPO}`;
const VIEWER = 'https://nocobase-growth-reports.gong-ads.chatgpt.site';
const CODE_SHA = 'a'.repeat(40);
const HTML = '<!doctype html><html><body><h1>Synthetic 中文 report</h1></body></html>';
const ENV = { REPORT_VIEWER_URL: VIEWER, REPORT_VIEWER_TOKEN: 'test-viewer-token', REPORTS_TOKEN: 'ghp_test-github-token' };
const sha = (value) => createHash('sha1').update(value).digest('hex');
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const errorCode = (code) => (error) => {
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  for (const privateValue of [ENV.REPORTS_TOKEN, ENV.REPORT_VIEWER_TOKEN, 'private-provider-body', 'private path']) {
    assert.equal(JSON.stringify(error).includes(privateValue), false);
  }
  return true;
};

function fixture({ dataThrough = '2026-10-08', html = HTML } = {}) {
  const runPath = 'runs/2026-10-11/123-test_1-2/';
  const latest = {
    schema_version: 1, repository: REPO, repository_id: REPO_ID, status: 'completed',
    report_date: '2026-10-11', data_through: dataThrough, run_id: '123-test_1', attempt: 2,
    code_sha: CODE_SHA, run_path: runPath, report_path: `${runPath}report.html`,
    report_url: `https://github.com/${REPO}/blob/develop/${runPath}report.html`, previous_report: null,
  };
  const run = {
    status: 'completed', report_status: dataThrough === null ? 'limited' : 'complete',
    report_date: latest.report_date, run_id: latest.run_id, attempt: latest.attempt,
    code_sha: CODE_SHA, data_through: dataThrough,
    archive: {
      schema_version: 1, repository: REPO, repository_id: REPO_ID, input_digest: 'b'.repeat(64),
      run_path: runPath, data_through: dataThrough, latest_updated: true, previous_report: null,
    },
  };
  return { latest, run, html, files: () => new Map([
    ['state/latest.json', JSON.stringify(latest)],
    [`${runPath}run.json`, JSON.stringify(run)],
    [`${runPath}report.html`, html],
  ]) };
}

// Read-only Git object store. Each immutable commit keeps its own tree/blob graph.
function server(input = fixture()) {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const calls = [];
  const api = {
    calls, metadataReads: 0, beforeRequest: null, viewerStatus: 'published', viewerResponses: [],
    metadata: {
      id: REPO_ID, full_name: REPO, name: 'nocobase-growth-reports', owner: { login: 'gchust' },
      private: true, visibility: 'private', default_branch: 'develop', archived: false, disabled: false,
    },
  };
  api.commit = (files) => {
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
    const tree = (items) => {
      const entries = [...items].map(([path, content]) => {
        if (content instanceof Map) return { path, mode: '040000', type: 'tree', sha: tree(content) };
        const bytes = Buffer.from(content);
        const id = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        blobs.set(id, { sha: id, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
        return { path, mode: '100644', type: 'blob', sha: id };
      });
      const id = sha(JSON.stringify(entries));
      trees.set(id, { sha: id, truncated: false, tree: entries });
      return id;
    };
    const rootSha = tree(root);
    const id = sha(`commit ${rootSha}`);
    commits.set(id, { sha: id, tree: { sha: rootSha } });
    api.head = id;
    return id;
  };
  api.commit(input.files());
  api.blobs = blobs;
  api.trees = trees;
  api.fetchImpl = async (url, init) => {
    const call = { url, ...init };
    calls.push(call);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (url.startsWith(GITHUB)) {
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.Authorization, `Bearer ${ENV.REPORTS_TOKEN}`);
      assert.equal(init.headers['OAI-Sites-Authorization'], undefined);
      assert.equal(JSON.stringify(init).includes(ENV.REPORT_VIEWER_TOKEN), false);
    } else {
      assert.equal(url, `${VIEWER}/api/reports`);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['OAI-Sites-Authorization'], `Bearer ${ENV.REPORT_VIEWER_TOKEN}`);
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(JSON.stringify(init).includes(ENV.REPORTS_TOKEN), false);
    }
    const hooked = await api.beforeRequest?.(call);
    if (hooked !== undefined) return hooked;
    if (url === `${VIEWER}/api/reports`) {
      if (api.viewerResponses.length) {
        const next = api.viewerResponses.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      return response({ status: api.viewerStatus, report_id: '2026-10-11/123-test_1-2' });
    }
    const path = url.slice(GITHUB.length);
    if (path === '') { api.metadataReads += 1; return response(api.metadata); }
    if (path === '/git/ref/heads/develop') return response({ ref: 'refs/heads/develop', object: { type: 'commit', sha: api.head } });
    if (path.startsWith('/git/commits/')) return response(commits.get(path.split('/').at(-1)));
    if (path.startsWith('/git/trees/')) return response(trees.get(path.split('/').at(-1)));
    if (path.startsWith('/git/blobs/')) return response(blobs.get(path.split('/').at(-1)));
    throw new Error('Unexpected private path');
  };
  api.publish = (env = ENV) => publishWebReport({ env, fetchImpl: api.fetchImpl });
  api.posts = () => calls.filter(({ method }) => method === 'POST');
  return api;
}

test('publishes validated latest from one immutable snapshot and separates credentials', async () => {
  const input = fixture();
  const api = server(input);
  assert.deepEqual(await api.publish(), { status: 'published' });
  assert.equal(api.metadataReads, 2);
  assert.equal(api.posts().length, 1);
  assert.deepEqual(JSON.parse(api.posts()[0].body), {
    schema_version: 1, repository: REPO, repository_id: REPO_ID,
    report_date: input.latest.report_date, run_id: input.latest.run_id, attempt: 2, code_sha: CODE_SHA,
    data_through: input.latest.data_through, report_status: 'complete', html: HTML,
  });
  assert.equal(api.calls.filter(({ url }) => url.endsWith('/git/ref/heads/develop')).length, 1);
  assert.ok(api.calls.every(({ url }) => !url.includes('/contents/') && !url.includes('raw.githubusercontent')));
});

test('accepts explicit unavailable Google data only as a limited report and supports unchanged', async () => {
  const api = server(fixture({ dataThrough: null }));
  api.viewerStatus = 'unchanged';
  assert.deepEqual(await api.publish({ ...ENV, REPORT_VIEWER_URL: `${VIEWER}/` }), { status: 'unchanged' });
  const payload = JSON.parse(api.posts()[0].body);
  assert.equal(payload.data_through, null);
  assert.equal(payload.report_status, 'limited');
});

test('rejects missing configuration and destination/token confusion before network access', async (t) => {
  const cases = [
    ['missing origin', { REPORT_VIEWER_URL: undefined }, 'WEB_PUBLISH_VIEWER_URL_REQUIRED'],
    ['missing site token', { REPORT_VIEWER_TOKEN: undefined }, 'WEB_PUBLISH_VIEWER_TOKEN_REQUIRED'],
    ['missing GitHub token', { REPORTS_TOKEN: undefined }, 'WEB_PUBLISH_REPORTS_TOKEN_REQUIRED'],
    ['site token newline', { REPORT_VIEWER_TOKEN: 'invalid\nheader' }, 'WEB_PUBLISH_VIEWER_TOKEN_REQUIRED'],
    ['GitHub token newline', { REPORTS_TOKEN: 'invalid\nheader' }, 'WEB_PUBLISH_REPORTS_TOKEN_REQUIRED'],
    ['same token', { REPORT_VIEWER_TOKEN: ENV.REPORTS_TOKEN }, 'WEB_PUBLISH_TOKEN_DESTINATION_INVALID'],
    ['PAT in site token', { REPORT_VIEWER_TOKEN: 'github_pat_wrong-destination' }, 'WEB_PUBLISH_TOKEN_DESTINATION_INVALID'],
  ];
  for (const url of [
    VIEWER.replace('https:', 'http:'), `${VIEWER}/api/reports`, `${VIEWER}?x=1`, `${VIEWER}#x`,
    `${VIEWER}:443`, `${VIEWER}/%2e`, `${VIEWER}/../`, `${VIEWER}/?`, `${VIEWER}/#`,
    VIEWER.replace('https://', 'https://user:password@'), `${VIEWER}.evil.invalid`, ` ${VIEWER}`,
  ]) cases.push(['invalid origin', { REPORT_VIEWER_URL: url }, 'WEB_PUBLISH_VIEWER_URL_INVALID']);
  for (const [name, changed, code] of cases) await t.test(name, async () => {
    const api = server();
    await assert.rejects(api.publish({ ...ENV, ...changed }), errorCode(code));
    assert.equal(api.calls.length, 0);
  });
});

test('rejects public, mismatched or disabled private archives before reading report data', async (t) => {
  for (const changed of [
    { private: false, visibility: 'public' }, { visibility: 'public' }, { id: REPO_ID + 1 },
    { full_name: 'someone/else' }, { name: 'else' }, { owner: { login: 'someone' } },
    { default_branch: 'main' }, { archived: true }, { disabled: true },
  ]) await t.test(JSON.stringify(changed), async () => {
    const api = server();
    Object.assign(api.metadata, changed);
    await assert.rejects(api.publish(), errorCode('WEB_PUBLISH_PRIVATE_REPOSITORY_INVALID'));
    assert.equal(api.calls.length, 1);
    assert.equal(api.posts().length, 0);
  });
});

test('rechecks private visibility immediately before publishing', async () => {
  const api = server();
  api.beforeRequest = ({ url }) => {
    if (url === GITHUB && api.metadataReads === 1) api.metadata.private = false;
  };
  await assert.rejects(api.publish(), errorCode('WEB_PUBLISH_PRIVATE_REPOSITORY_INVALID'));
  assert.equal(api.posts().length, 0);
});

test('a concurrent branch advance cannot mix latest metadata and report HTML', async () => {
  const input = fixture();
  const api = server(input);
  const original = api.head;
  api.beforeRequest = ({ url }) => {
    if (url === `${GITHUB}/git/commits/${original}`) {
      api.commit(fixture({ html: '<html>New content from another commit</html>' }).files());
    }
  };
  assert.deepEqual(await api.publish(), { status: 'published' });
  assert.notEqual(api.head, original);
  assert.equal(JSON.parse(api.posts()[0].body).html, HTML);
});

test('invalid paths, dates, statuses, identities and marker metadata never reach the viewer', async (t) => {
  const cases = [
    ['path traversal', (x) => { x.latest.report_path = '../report.html'; }],
    ['run path mismatch', (x) => { x.latest.run_path += 'other/'; }],
    ['report URL mismatch', (x) => { x.latest.report_url = 'https://evil.invalid/report.html'; }],
    ['invalid code SHA', (x) => { x.latest.code_sha = 'a'.repeat(39); }],
    ['failed latest', (x) => { x.latest.status = 'failed'; }],
    ['latest repository mismatch', (x) => { x.latest.repository_id += 1; }],
    ['missing cutoff', (x) => { delete x.latest.data_through; }],
    ['invalid date', (x) => { x.latest.data_through = '2026-02-30'; }],
    ['future cutoff', (x) => { x.latest.data_through = '2026-10-12'; }],
    ['too many attempts', (x) => { x.latest.attempt = 1001; }],
    ['invalid run id', (x) => { x.latest.run_id = '../bad'; }],
    ['failed marker', (x) => { x.run.status = 'failed'; }],
    ['run identity mismatch', (x) => { x.run.run_id = 'different'; }],
    ['run SHA mismatch', (x) => { x.run.code_sha = 'c'.repeat(40); }],
    ['missing marker cutoff', (x) => { delete x.run.data_through; }],
    ['marker cutoff mismatch', (x) => { x.run.data_through = null; }],
    ['invalid report status', (x) => { x.run.report_status = 'completed'; }],
    ['marker not latest', (x) => { x.run.archive.latest_updated = false; }],
    ['marker repository mismatch', (x) => { x.run.archive.repository_id += 1; }],
    ['marker path mismatch', (x) => { x.run.archive.run_path = 'runs/elsewhere/'; }],
    ['missing archive cutoff', (x) => { delete x.run.archive.data_through; }],
    ['invalid archive digest', (x) => { x.run.archive.input_digest = 'bad'; }],
    ['null complete report', (x) => { x.latest.data_through = null; x.run.data_through = null; x.run.archive.data_through = null; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const input = fixture();
    mutate(input);
    const api = server(input);
    await assert.rejects(api.publish(), errorCode('WEB_PUBLISH_ARCHIVE_INVALID'));
    assert.equal(api.posts().length, 0);
  });
});

test('verifies Git blob hashes, canonical base64, tree modes and complete responses', async (t) => {
  for (const [name, mutate] of [
    ['changed content', (api) => { [...api.blobs.values()][0].content = Buffer.from('{}').toString('base64'); }],
    ['wrong blob size', (api) => { [...api.blobs.values()][0].size += 1; }],
    ['bad base64', (api) => { [...api.blobs.values()][0].content += '$'; }],
    ['truncated tree', (api) => { for (const tree of api.trees.values()) tree.truncated = true; }],
    ['symlink blob', (api) => { for (const tree of api.trees.values()) for (const entry of tree.tree) if (entry.type === 'blob') entry.mode = '120000'; }],
  ]) await t.test(name, async () => {
    const api = server();
    mutate(api);
    await assert.rejects(api.publish(), errorCode('WEB_PUBLISH_ARCHIVE_INVALID'));
    assert.equal(api.posts().length, 0);
  });
});

test('rejects GitHub and viewer redirects without sending credentials to another destination', async (t) => {
  for (const stage of ['github', 'viewer']) for (const variant of ['status', 'redirected', 'url']) {
    await t.test(`${stage} ${variant}`, async () => {
      const api = server();
      api.beforeRequest = ({ url }) => {
        if (url !== (stage === 'github' ? GITHUB : `${VIEWER}/api/reports`)) return undefined;
        const result = response({}, variant === 'status' ? 302 : 200, { location: 'https://evil.invalid/private path' });
        if (variant === 'redirected') Object.defineProperty(result, 'redirected', { value: true });
        if (variant === 'url') Object.defineProperty(result, 'url', { value: 'https://evil.invalid/private path' });
        return result;
      };
      await assert.rejects(api.publish(), errorCode('WEB_PUBLISH_REDIRECT_REJECTED'));
      assert.ok(api.calls.every(({ url }) => url.startsWith(GITHUB) || url === `${VIEWER}/api/reports`));
      assert.equal(api.posts().length, stage === 'viewer' ? 1 : 0);
    });
  }
});

test('transient reads retry, and a lost POST response retries the identical payload idempotently', async () => {
  const api = server();
  let throttled = false;
  api.beforeRequest = ({ url }) => {
    if (url.endsWith('/git/ref/heads/develop') && !throttled) {
      throttled = true;
      return response({ private: 'private-provider-body' }, 429, { 'retry-after': '0' });
    }
  };
  api.viewerResponses.push(new Error('private-provider-body including private path and ghp_test-github-token'));
  api.viewerStatus = 'unchanged';
  assert.deepEqual(await api.publish(), { status: 'unchanged' });
  assert.equal(api.calls.filter(({ url }) => url.endsWith('/git/ref/heads/develop')).length, 2);
  assert.equal(api.posts().length, 2);
  assert.equal(api.posts()[0].body, api.posts()[1].body);
});

test('retry limits and permanent errors return fixed codes without provider data', async (t) => {
  for (const [status, count, code] of [
    [408, 3, 'WEB_PUBLISH_SERVICE_UNAVAILABLE'], [429, 3, 'WEB_PUBLISH_SERVICE_UNAVAILABLE'],
    [503, 3, 'WEB_PUBLISH_SERVICE_UNAVAILABLE'], [401, 1, 'WEB_PUBLISH_REQUEST_REJECTED'],
    [403, 1, 'WEB_PUBLISH_REQUEST_REJECTED'], [409, 1, 'WEB_PUBLISH_REQUEST_REJECTED'],
  ]) await t.test(String(status), async () => {
    const api = server();
    api.viewerResponses = Array.from({ length: 3 }, () => response({ message: 'private-provider-body' }, status, { 'retry-after': '0' }));
    await assert.rejects(api.publish(), errorCode(code));
    assert.equal(api.posts().length, count);
  });
  const unavailable = server();
  unavailable.beforeRequest = () => { throw new Error('private-provider-body'); };
  await assert.rejects(unavailable.publish(), errorCode('WEB_PUBLISH_TRANSPORT_UNAVAILABLE'));
  assert.equal(unavailable.calls.length, 3);
});

test('only valid response statuses count as success and malformed JSON is not retried', async (t) => {
  for (const reply of [response({ status: 'queued' }), response({ status: true }), new Response('{invalid')]) {
    await t.test('invalid response', async () => {
      const api = server();
      api.viewerResponses.push(reply);
      await assert.rejects(api.publish(), errorCode('WEB_PUBLISH_RESPONSE_INVALID'));
      assert.equal(api.posts().length, 1);
    });
  }
});

test('limits the serialized UTF-8 JSON payload, including escaping overhead', async () => {
  // HTML itself is under 2 MiB, but JSON escaping exceeds the allowed request size.
  const api = server(fixture({ html: `<html>${'"'.repeat(1100 * 1024)}</html>` }));
  await assert.rejects(api.publish(), errorCode('WEB_PUBLISH_REPORT_TOO_LARGE'));
  assert.equal(api.posts().length, 0);
  const oversized = server();
  oversized.beforeRequest = () => new Response('private-provider-body', { headers: { 'content-length': '99999999' } });
  await assert.rejects(oversized.publish(), errorCode('WEB_PUBLISH_RESPONSE_TOO_LARGE'));
  assert.equal(oversized.calls.length, 1);
});
