import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGoogle } from '../src/google.mjs';
import { collectTechnical } from '../src/technical.mjs';
import { analyzeReport } from '../src/analyze.mjs';
import { ROOT, preflight, prepareRun, collectRun, analyzeRun, publishRun, recordFailure, saveFailure } from '../src/pipeline.mjs';

const original = JSON.parse(await readFile(join(ROOT, 'sites/nocobase.json'), 'utf8'));
const config = { ...original, pages: ['https://www.nocobase.com/en/'], ga4: { property_id: '12345', hostname: 'www.nocobase.com' } };
const previous = { summary: null, site_checks: null, latest: null };
const now = new Date('2026-10-11T01:17:00Z');

test('preflight permits absent Google credentials and still requires model and private archive access', async () => {
  let verified = 0;
  const verify = async options => {
    verified++;
    assert.equal(options.repository, 'gchust/nocobase-growth-reports');
    assert.equal(options.repository_id, original.archive.repository_id);
    assert.equal(options.token, 'synthetic-private-token');
  };
  for (const google of [{}, { GOOGLE_CREDENTIALS_JSON: '', GOOGLE_CREDENTIALS_PRESENT: 'false' }]) {
    assert.deepEqual(await preflight({ env: { ...google, DEEPSEEK_API_KEY_PRESENT: 'true', REPORTS_TOKEN: 'synthetic-private-token' }, verify }), { status: 'ready_for_first_run' });
  }
  assert.equal(verified, 2);
  await assert.rejects(preflight({ env: { REPORTS_TOKEN: 'synthetic-private-token' }, verify }), /MODEL_CREDENTIALS_REQUIRED/);
  assert.equal(verified, 2);
  await assert.rejects(preflight({ env: { DEEPSEEK_API_KEY_PRESENT: 'true' }, verify: async () => { throw Error('ARCHIVE_TARGET_NOT_PRIVATE'); } }), /ARCHIVE_TARGET_NOT_PRIVATE/);
});

test('missing Google credentials still run page checks, model analysis and private report publication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'growth-without-google-'));
  const env = { GROWTH_WORK_DIR: dir, GROWTH_CODE_SHA: '1'.repeat(40), REPORTS_TOKEN: 'synthetic-private-token', DEEPSEEK_API_KEY: 'synthetic-model-token' };
  let googleRequests = 0, pageRequests = 0, modelRequests = 0;
  try {
    await prepareRun({ env, config, now, verify: async options => {
      assert.equal(options.repository, 'gchust/nocobase-growth-reports');
      assert.equal(options.repository_id, original.archive.repository_id);
    }, readPrevious: async () => previous });
    const facts = await collectRun({ env, now,
      google: (site, options) => collectGoogle(site, { ...options, fetchImpl: () => { googleRequests++; throw Error('Google must not be called'); } }),
      technical: (site, seo, old, options) => {
        assert.equal(seo, null);
        return collectTechnical(site, seo, old, { ...options, fetchImpl: async url => {
          pageRequests++;
          assert.equal(url, config.pages[0]);
          return new Response('<html><head><title>Synthetic page</title><meta name="description" content="Synthetic summary"><link rel="canonical" href="https://www.nocobase.com/en/"></head><h1>Synthetic heading</h1></html>', { headers: { 'content-type': 'text/html' } });
        } });
      } });
    assert.equal(facts.report_status, 'limited');
    assert.equal(facts.seo, null);
    assert.equal(facts.analytics, null);
    assert.equal(facts.site_checks.checked_pages, 1);
    assert.ok(facts.evidence.every(item => item.source_id === 'pages'));
    const insights = { summary: '仅完成页面检查；缺少搜索效果数据，无法判断搜索增长。', hypotheses: [], actions: [], limitations: ['未配置 Google 凭证。'] };
    const report = await analyzeRun({ env, analyzer: (input, history, site, options) => analyzeReport(input, history, site, { ...options, execute: async (command, args, execution) => {
      assert.equal(execution.env.REPORTS_TOKEN, undefined);
      assert.equal(execution.env.GOOGLE_CREDENTIALS_JSON, undefined);
      if (args[0] === '--version') return { code: 0, stdout: site.model.claude_code_version + ' (Claude Code)', stderr: '' };
      modelRequests++;
      const modelInput = JSON.parse(execution.input);
      assert.equal(modelInput.seo, null);
      assert.equal(modelInput.analytics, null);
      return { code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(insights) }), stderr: '' };
    } }) });
    assert.equal(report.report_status, 'limited');
    let archived;
    const published = await publishRun({ env, archive: async options => {
      archived = options;
      assert.equal(options.repository, 'gchust/nocobase-growth-reports');
      assert.equal(options.repository_id, original.archive.repository_id);
      return { commit_sha: '2'.repeat(40), run_path: `runs/${options.report_date}/${options.run_id}-${options.attempt}/`, latest_updated: true };
    } });
    assert.equal(archived.status, 'completed');
    assert.equal(archived.state.summary.data_through, null);
    assert.equal(archived.state.summary.comparisons, null);
    assert.equal(JSON.parse(archived.files['run.json']).data_through, null);
    assert.equal(JSON.parse(archived.files['run.json']).report_status, 'limited');
    assert.equal(JSON.parse(archived.files['report.json']).seo, null);
    assert.match(archived.files['report.html'], /暂不能判断搜索增长/);
    assert.match(archived.files['report.md'], /暂不能判断搜索增长/);
    assert.deepEqual(Object.keys(archived.files).sort(), ['analysis.json', 'metrics.json', 'report.html', 'report.json', 'report.md', 'run.json']);
    assert.equal(published.latest_updated, true);
    assert.equal((await recordFailure({ env, archive: async () => { throw Error('must not publish again'); } })).status, 'already_published');
    assert.equal(googleRequests, 0);
    assert.equal(pageRequests, 1);
    assert.equal(modelRequests, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('nonempty invalid Google credentials keep the pipeline failed and never publish success state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'growth-invalid-google-'));
  const env = { GROWTH_WORK_DIR: dir, GROWTH_CODE_SHA: '1'.repeat(40), REPORTS_TOKEN: 'synthetic-private-token', GOOGLE_CREDENTIALS_JSON: 'PRIVATE_BROKEN_JSON' };
  let pageRequests = 0, googleRequests = 0;
  try {
    await prepareRun({ env, config, now, verify: async () => {}, readPrevious: async () => previous });
    let failure;
    await assert.rejects(collectRun({ env, now,
      google: (site, options) => collectGoogle(site, { ...options, fetchImpl: () => { googleRequests++; } }),
      technical: async () => { pageRequests++; throw Error('must not continue after configured Google failure'); },
    }), error => { failure = error; return error.code === 'GOOGLE_CREDENTIALS_INVALID'; });
    await saveFailure('collect', failure, env);
    let archived;
    await recordFailure({ env, archive: async options => { archived = options; return {}; } });
    assert.equal(archived.status, 'failed');
    assert.equal(archived.state, undefined);
    assert.deepEqual(Object.keys(archived.files), ['run.json']);
    assert.ok(!archived.files['run.json'].includes('PRIVATE_BROKEN_JSON'));
    assert.equal(pageRequests, 0);
    assert.equal(googleRequests, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
