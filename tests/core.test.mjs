import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validDate, safeUrl, dateInZone, validateConfig, applyModelOverrides, loadConfig } from '../src/config.mjs';
import { modelEnvironment, parseModelResult, analyzeReport, executeCaptured } from '../src/analyze.mjs';
import { validateAnalysis } from '../src/validate.mjs';
import { parsePage, fetchPage, compareChecks, selectPages } from '../src/technical.mjs';
import { makeDemoReport } from '../src/demo.mjs';
import { ROOT, workDirectory, preflight, prepareRun, collectRun, analyzeRun, publishRun, recordFailure, saveFailure } from '../src/pipeline.mjs';
import { main } from '../src/cli.mjs';

const original = JSON.parse(await readFile(join(ROOT, 'sites/nocobase.json'), 'utf8'));
const config = { ...original, archive: { ...original.archive, repository_id: 12345 } };
const schema = JSON.parse(await readFile(join(ROOT, 'schemas/analysis.schema.json'), 'utf8'));
const demo = makeDemoReport(config);
const previous = { summary: null, site_checks: null, latest: null };

test('date validation and source timezone do not accept normalized impossible dates', () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(dateInZone(new Date('2026-10-11T01:00:00Z'), 'America/Los_Angeles'), '2026-10-10');
  assert.equal(dateInZone(new Date('2026-10-11T01:00:00Z'), 'Asia/Shanghai'), '2026-10-11');
});

test('configuration keeps site hosts restricted while allowing custom HTTPS model endpoints', () => {
  assert.ok(validateConfig(config));
  assert.ok(validateConfig({ ...config, model: { ...config.model, provider_base_url: 'https://gateway.example:8443/anthropic', id: 'provider/deepseek-v4.1_flash:fast' } }));
  assert.ok(validateConfig({ ...config, model: { ...config.model, id: 'provider/model[1m]' } }));
  assert.throws(() => validateConfig({ ...config, model: { ...config.model, provider_base_url: 'http://gateway.example/anthropic' } }), /CONFIG_INVALID_MODEL_ENDPOINT/);
  assert.equal(safeUrl('https://www.nocobase.com.evil.example/en', config.allowed_hosts), null);
  assert.equal(safeUrl('https://key@www.nocobase.com/en', config.allowed_hosts), null);
  assert.equal(safeUrl('http://127.0.0.1', config.allowed_hosts), null);
});

test('model overrides are immutable and absent or blank values preserve site defaults', async () => {
  const before = structuredClone(config);
  const overridden = applyModelOverrides(config, { DEEPSEEK_BASE_URL: 'https://gateway.example:8443/provider/anthropic', DEEPSEEK_MODEL: 'provider/model-v4.1:flash' });
  assert.notEqual(overridden, config);
  assert.notEqual(overridden.model, config.model);
  assert.equal(overridden.model.provider_base_url, 'https://gateway.example:8443/provider/anthropic');
  assert.equal(overridden.model.id, 'provider/model-v4.1:flash');
  assert.deepEqual(config, before);
  for (const env of [{}, { DEEPSEEK_BASE_URL: '', DEEPSEEK_MODEL: '' }, { DEEPSEEK_BASE_URL: ' \t\n ', DEEPSEEK_MODEL: ' \t\n ' }]) {
    assert.deepEqual(applyModelOverrides(config, env).model, config.model);
    assert.deepEqual((await loadConfig(join(ROOT, 'sites/nocobase.json'), { env })).model, original.model);
  }
  const loaded = await loadConfig(join(ROOT, 'sites/nocobase.json'), { env: { DEEPSEEK_BASE_URL: 'https://gateway.example/anthropic', DEEPSEEK_MODEL: 'provider/name:1.0' } });
  assert.equal(loaded.model.provider_base_url, 'https://gateway.example/anthropic');
  assert.equal(loaded.model.id, 'provider/name:1.0');
});

test('preflight rejects unsafe endpoint or model overrides before repository access without leaking values', async () => {
  const endpoints = [
    'http://PRIVATE_CANARY.example/anthropic', 'https://user:PRIVATE_CANARY@gateway.example/anthropic',
    'https://@gateway.example', 'https://gateway.example/anthropic?key=PRIVATE_CANARY', 'https://gateway.example/?',
    'https://gateway.example/#PRIVATE_CANARY', 'https://gateway.example/#',
    'https://gateway.example/\nPRIVATE_CANARY', 'https://gateway.example/\u0085PRIVATE_CANARY',
    '//PRIVATE_CANARY.example/anthropic', 'PRIVATE_CANARY.example/anthropic', '/PRIVATE_CANARY',
    'https:/PRIVATE_CANARY.example', 'https:///PRIVATE_CANARY.example', 'https://gateway.example\\PRIVATE_CANARY',
    'https://gateway.example/' + 'a'.repeat(2048),
  ];
  let verifications = 0;
  const verify = async () => { verifications++; };
  for (const endpoint of endpoints) {
    await assert.rejects(preflight({ env: { DEEPSEEK_BASE_URL: endpoint }, verify }), error => {
      assert.equal(error.code, 'CONFIG_INVALID_MODEL_ENDPOINT');
      assert.equal(error.message, 'CONFIG_INVALID_MODEL_ENDPOINT');
      assert.equal(error.cause, undefined);
      assert.ok(!JSON.stringify(error).includes('PRIVATE_CANARY'));
      return true;
    });
  }
  for (const model of ['provider/PRIVATE CANARY', 'provider/PRIVATE\nCANARY', 'a'.repeat(201)]) {
    await assert.rejects(preflight({ env: { DEEPSEEK_MODEL: model }, verify }), error => {
      assert.equal(error.code, 'CONFIG_INVALID_MODEL');
      assert.equal(error.message, 'CONFIG_INVALID_MODEL');
      return true;
    });
  }
  await assert.rejects(prepareRun({ config, env: { DEEPSEEK_BASE_URL: endpoints[0] }, verify, readPrevious: async () => { throw Error('must not read history'); } }), /CONFIG_INVALID_MODEL_ENDPOINT/);
  assert.equal(verifications, 0);
});

test('prepare persists model overrides and later analysis uses those exact settings with isolated credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'growth-custom-model-test-'));
  const endpoint = 'https://gateway.example:8443/tenant/anthropic';
  const model = 'provider/deepseek-v4.1_flash:fast';
  const env = { GROWTH_WORK_DIR: dir, GROWTH_CODE_SHA: '1'.repeat(40), DEEPSEEK_BASE_URL: endpoint, DEEPSEEK_MODEL: model,
    DEEPSEEK_API_KEY: 'synthetic-model-key', REPORTS_TOKEN: 'never-github', GOOGLE_CREDENTIALS_JSON: 'never-google', GITHUB_OUTPUT: '/public-output' };
  const before = structuredClone(config);
  try {
    await prepareRun({ env, config, verify: async () => {}, readPrevious: async () => previous });
    const saved = JSON.parse(await readFile(join(dir, 'context.json'), 'utf8'));
    assert.equal(saved.config.model.provider_base_url, endpoint);
    assert.equal(saved.config.model.id, model);
    assert.equal(saved.run.model, model);
    assert.deepEqual(config, before);
    await collectRun({ env,
      google: async () => ({ sources: demo.sources.slice(0, 2), seo: demo.seo, analytics: null, evidence: [demo.evidence[0]] }),
      technical: async () => ({ source: demo.sources[2], site_checks: demo.site_checks, evidence: [demo.evidence[1]] }) });
    // Environment changes after prepare must not redirect this run's analysis.
    env.DEEPSEEK_BASE_URL = 'https://later.example/anthropic';
    env.DEEPSEEK_MODEL = 'later/model';
    const calls = [];
    const execute = async (command, args, opts) => {
      calls.push({ command, args, opts });
      if (args[0] === '--version') return { code: 0, stdout: config.model.claude_code_version + ' (Claude Code)', stderr: '' };
      return { code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(demo.insights) }), stderr: '' };
    };
    const report = await analyzeRun({ env, analyzer: (facts, history, savedConfig, options) => analyzeReport(facts, history, savedConfig, { ...options, execute }) });
    assert.equal(report.run.model, model);
    assert.equal(calls[1].args[calls[1].args.indexOf('--model') + 1], model);
    for (const { opts } of calls) {
      assert.equal(opts.env.ANTHROPIC_BASE_URL, endpoint);
      for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(opts.env[key], model);
      assert.equal(opts.env.ANTHROPIC_API_KEY, 'synthetic-model-key');
      for (const key of ['REPORTS_TOKEN', 'GOOGLE_CREDENTIALS_JSON', 'GITHUB_OUTPUT', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL']) assert.equal(opts.env[key], undefined);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model environment excludes Google, GitHub and public Actions output channels', () => {
  const env = modelEnvironment({ PATH: '/bin', DEEPSEEK_API_KEY: 'fixture-model', GOOGLE_CREDENTIALS_JSON: 'never-google',
    REPORTS_TOKEN: 'never-github', GITHUB_STEP_SUMMARY: '/public-summary', GITHUB_OUTPUT: '/public-output', GITHUB_ENV: '/public-env',
    HOME: '/original-home', NODE_OPTIONS: '--require=evil' }, config, '/tmp/model');
  for (const key of ['REPORTS_TOKEN', 'GOOGLE_CREDENTIALS_JSON', 'GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT', 'GITHUB_ENV', 'HOME', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-flash');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-flash');
});

test('analysis rejects unknown evidence, external URLs, extra metrics and malformed envelopes', () => {
  assert.ok(validateAnalysis(structuredClone(demo.insights), schema, demo, config));
  const unknown = structuredClone(demo.insights); unknown.actions[0].evidence_ids = ['invented'];
  assert.throws(() => validateAnalysis(unknown, schema, demo, config), /UNKNOWN_EVIDENCE/);
  const external = structuredClone(demo.insights); external.actions[0].target_urls = ['https://evil.example/leak'];
  assert.throws(() => validateAnalysis(external, schema, demo, config), /UNAPPROVED_URL/);
  assert.throws(() => validateAnalysis({ ...demo.insights, metrics: {} }, schema, demo, config), /SCHEMA_INVALID/);
  assert.throws(() => parseModelResult(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: '{}' })), /MODEL_RUN_FAILED/);
  assert.throws(() => parseModelResult(JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: '{}' })), /MODEL_RUN_FAILED/);
  assert.throws(() => parseModelResult('private provider error'), /MODEL_RESPONSE_INVALID/);
});

test('Claude invocation is deterministic, tool-free and provider-schema independent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'growth-model-test-'));
  try {
    const calls = [];
    const execute = async (command, args, opts) => {
      calls.push({ command, args, opts });
      if (args[0] === '--version') return { code: 0, stdout: config.model.claude_code_version + ' (Claude Code)', stderr: '' };
      return { code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(demo.insights) }), stderr: '' };
    };
    await analyzeReport(demo, previous, config, { root: ROOT, workDir: dir, env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'synthetic' }, execute });
    const args = calls[1].args;
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--bare'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(!args.includes('--json-schema'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.match(await readFile(join(dir, 'system-prompt.txt'), 'utf8'), /Return exactly one JSON object/);
    assert.match(calls[1].opts.input, /synthetic-gsc/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('captured subprocess output handles split UTF-8 and is never streamed', async () => {
  const result = await executeCaptured(process.execPath, ['-e', "const b=Buffer.from('增长');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10);"], { env: { PATH: process.env.PATH }, timeoutMs: 1000 });
  assert.equal(result.stdout, '增长');
});

test('static checks parse metadata and do not resolve findings after failed fetch', async () => {
  const html = '<html><head><title>Noco &amp; Base</title><meta content="noindex,follow" name="robots"><link href="/en/" rel="canonical"></head><h1>Welcome</h1></html>';
  const parsed = parsePage(html, 'https://www.nocobase.com/en/');
  assert.equal(parsed.title, 'Noco & Base'); assert.equal(parsed.noindex, true);
  assert.equal(parsePage('<meta name="robots" content="none">', 'https://www.nocobase.com').noindex, true);
  assert.equal(parsed.canonical, 'https://www.nocobase.com/en/');
  const page = { ...parsed, url: 'https://www.nocobase.com/en/', final_url: 'https://www.nocobase.com/en/', check_status: 'ok', status_code: 200 };
  const first = compareChecks([page], null);
  const next = compareChecks([{ url: page.url, check_status: 'error' }], first);
  assert.equal(next.findings.find(f => f.check_type === 'noindex').state, 'unverified');
  assert.equal(next.resolved_count, 0);
  const repeated = compareChecks([{ url: page.url, check_status: 'error' }], next);
  assert.equal(repeated.findings.find(f => f.check_type === 'noindex').description, next.findings.find(f => f.check_type === 'noindex').description);
  const recovered = compareChecks([{ ...page, noindex: false }], first);
  assert.equal(recovered.findings.find(f => f.check_type === 'noindex').state, 'resolved');
  const titleChange = compareChecks([{ ...page, title: 'New title' }], first);
  assert.equal(titleChange.changes[0].field, 'title');
  assert.ok(!titleChange.findings.some(f => f.check_type === 'title_changed'));
  const redirected = await fetchPage(page.url, config, { fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }) });
  assert.equal(redirected.error_code, 'PAGE_REDIRECT_REJECTED');
});

test('page selection only admits configured hosts and bounds crawl count', () => {
  const selected = selectPages({ ...config, page_limit: 5 }, { movers: { '7d': { pages: [{ key: 'http://127.0.0.1' }, { key: 'https://www.nocobase.com/en/test' }] } } });
  assert.equal(selected.length, 5);
  assert.ok(selected.every(u => u.startsWith('https://www.nocobase.com/')));
});

test('work directories cannot escape runner temporary storage', () => {
  assert.throws(() => workDirectory({ GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/tmp/runner', GROWTH_WORK_DIR: '/repo/public' }), /REJECTED/);
});

test('full staged pipeline uses synthetic providers and archives only six approved files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'growth-pipeline-test-'));
  const env = { GROWTH_WORK_DIR: dir, GROWTH_CODE_SHA: '1'.repeat(40), REPORTS_TOKEN: 'synthetic' };
  try {
    let verified = 0, modelCalls = 0, archived;
    await prepareRun({ env, now: new Date('2026-10-11T01:17:00Z'), config, verify: async () => { verified++; }, readPrevious: async () => previous });
    await collectRun({ env,
      google: async () => ({ sources: demo.sources.slice(0, 2), seo: demo.seo, analytics: null, evidence: [demo.evidence[0]] }),
      technical: async () => ({ source: demo.sources[2], site_checks: demo.site_checks, evidence: [demo.evidence[1]] }) });
    await analyzeRun({ env, analyzer: async () => { modelCalls++; return { insights: demo.insights, usage: {} }; } });
    await publishRun({ env, archive: async opts => { archived = opts; return { commit_sha: '2'.repeat(40), run_path: 'runs/synthetic/', latest_updated: true }; } });
    assert.equal(verified, 1); assert.equal(modelCalls, 1);
    assert.deepEqual(Object.keys(archived.files).sort(), ['analysis.json', 'metrics.json', 'report.html', 'report.json', 'report.md', 'run.json']);
    assert.equal(archived.state.summary.data_through, demo.seo.data_through);
    assert.equal(JSON.parse(archived.files['report.json']).history.index_url, 'https://github.com/gchust/nocobase-growth-reports/tree/develop/runs');
    assert.equal(archived.status, 'completed');
    assert.equal((await recordFailure({ env, archive: async () => { throw Error('must not repeat'); } })).status, 'already_published');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failure record has only fixed codes and does not advance successful state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'growth-failure-test-'));
  const env = { GROWTH_WORK_DIR: dir, GROWTH_CODE_SHA: '1'.repeat(40), REPORTS_TOKEN: 'synthetic' };
  try {
    await prepareRun({ env, config, verify: async () => {}, readPrevious: async () => previous });
    await saveFailure('collect', new Error('PRIVATE_CANARY_RESPONSE_BODY'), env);
    let archived;
    await recordFailure({ env, archive: async opts => { archived = opts; return {}; } });
    assert.equal(archived.status, 'failed'); assert.equal(archived.state, undefined);
    assert.deepEqual(Object.keys(archived.files), ['run.json']);
    assert.ok(!archived.files['run.json'].includes('PRIVATE_CANARY_RESPONSE_BODY'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('configured GA4 failure archives a limited report without success state and fails the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'growth-source-error-test-'));
  const env = { GROWTH_WORK_DIR: dir, GROWTH_CODE_SHA: '1'.repeat(40), REPORTS_TOKEN: 'synthetic' };
  try {
    await prepareRun({ env, config, verify: async () => {}, readPrevious: async () => previous });
    await collectRun({ env,
      google: async () => ({ sources: [demo.sources[0], { ...demo.sources[1], status: 'error', reason: 'GA4_QUERY_FAILED' }], seo: demo.seo, analytics: null, evidence: [demo.evidence[0]] }),
      technical: async () => ({ source: demo.sources[2], site_checks: demo.site_checks, evidence: [demo.evidence[1]] }) });
    await analyzeRun({ env, analyzer: async () => ({ insights: demo.insights, usage: {} }) });
    let archived;
    await assert.rejects(publishRun({ env, archive: async opts => { archived = opts; return {}; } }), /REPORT_CONFIGURED_SOURCE_FAILED/);
    assert.equal(archived.status, 'failed'); assert.equal(archived.state, undefined);
    assert.ok(archived.files['report.html']);
    assert.equal(JSON.parse(archived.files['report.json']).report_status, 'limited');
    assert.equal((await recordFailure({ env, archive: async () => { throw Error('must not retry'); } })).status, 'already_published');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('publication failure retries identical report bytes without another analysis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'growth-retry-test-'));
  const env = { GROWTH_WORK_DIR: dir, GROWTH_CODE_SHA: '1'.repeat(40), REPORTS_TOKEN: 'synthetic' };
  try {
    await prepareRun({ env, config, verify: async () => {}, readPrevious: async () => previous });
    await collectRun({ env,
      google: async () => ({ sources: demo.sources.slice(0, 2), seo: demo.seo, analytics: null, evidence: [demo.evidence[0]] }),
      technical: async () => ({ source: demo.sources[2], site_checks: demo.site_checks, evidence: [demo.evidence[1]] }) });
    let analyses = 0, first;
    await analyzeRun({ env, analyzer: async () => { analyses++; return { insights: demo.insights, usage: {} }; } });
    await assert.rejects(publishRun({ env, archive: async opts => { first = opts; throw Error('temporary transport failure'); } }));
    await recordFailure({ env, archive: async opts => { assert.deepEqual(opts.files, first.files); return {}; } });
    assert.equal(analyses, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI does not echo credentials or unknown commands into public logs', async () => {
  let output = '';
  const exit = await main(['PRIVATE_COMMAND_CANARY'], { DEEPSEEK_API_KEY: 'PRIVATE_KEY_CANARY' }, { write: text => { output += text; } });
  assert.equal(exit, 2); assert.ok(!output.includes('CANARY'));
});
