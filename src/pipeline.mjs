import { mkdir, readFile, writeFile, lstat, chmod } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SafeError, loadConfig, applyModelOverrides, validateConfig, dateInZone, validDate } from './config.mjs';
import { REPORTS_BRANCH, verifyPrivateRepository, readPreviousState, archiveRun } from './archive.mjs';
import { collectGoogle } from './google.mjs';
import { collectTechnical } from './technical.mjs';
import { analyzeReport } from './analyze.mjs';
import { validateFacts } from './validate.mjs';
import { renderReport, renderMarkdown } from './render.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';

export function workDirectory(env = process.env) {
  const path = resolve(env.GROWTH_WORK_DIR || join(tmpdir(), 'nocobase-growth-local'));
  if (env.GITHUB_ACTIONS === 'true') {
    const root = resolve(env.RUNNER_TEMP || '/invalid-runner-temp');
    const rel = relative(root, path);
    if (!env.RUNNER_TEMP || !rel || rel.startsWith('..') || rel.startsWith('/')) throw new SafeError('WORK_DIRECTORY_REJECTED');
  }
  return path;
}

async function initializeDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SafeError('WORK_DIRECTORY_REJECTED');
  await chmod(path, 0o700);
}

export async function saveJson(dir, name, value) {
  await writeFile(join(dir, name), json(value), { mode: 0o600 });
}

async function readJson(dir, name) {
  try { return JSON.parse(await readFile(join(dir, name), 'utf8')); }
  catch { throw new SafeError('RUN_STATE_MISSING_OR_INVALID'); }
}

function archiveOptions(config, env) {
  return { ...config.archive, token: env.REPORTS_TOKEN };
}

export async function preflight({ env = process.env, verify = verifyPrivateRepository } = {}) {
  const config = await loadConfig(join(ROOT, 'sites/nocobase.json'), { env });
  if (!(env.GOOGLE_CREDENTIALS_JSON || env.GOOGLE_CREDENTIALS_PRESENT === 'true')) throw new SafeError('GOOGLE_CREDENTIALS_REQUIRED');
  if (!(env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY_PRESENT === 'true')) throw new SafeError('MODEL_CREDENTIALS_REQUIRED');
  await verify(archiveOptions(config, env));
  return { status: 'ready_for_first_run' };
}

export async function prepareRun({ env = process.env, now = new Date(), config: suppliedConfig, verify = verifyPrivateRepository, readPrevious = readPreviousState } = {}) {
  const config = suppliedConfig
    ? validateConfig(applyModelOverrides(suppliedConfig, env))
    : await loadConfig(join(ROOT, 'sites/nocobase.json'), { env });
  if (env.AS_OF && !validDate(env.AS_OF)) throw new SafeError('INVALID_AS_OF_DATE');
  if (env.GITHUB_ACTIONS === 'true' && (env.GITHUB_REPOSITORY !== 'gchust/nocobase-growth' || env.GITHUB_REF !== 'refs/heads/main')) throw new SafeError('UNTRUSTED_WORKFLOW_REF');
  const options = archiveOptions(config, env);
  await verify(options); // No business data is fetched before this check succeeds.
  const previous = await readPrevious(options);
  const dir = workDirectory(env);
  await initializeDirectory(dir);
  try { await lstat(join(dir, 'context.json')); throw new SafeError('WORK_DIRECTORY_NOT_EMPTY'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const run = {
    id: env.GITHUB_RUN_ID || 'local-' + String(now.getTime()),
    attempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
    code_sha: env.GITHUB_SHA || env.GROWTH_CODE_SHA || '',
    url: env.GITHUB_RUN_ID ? 'https://github.com/gchust/nocobase-growth/actions/runs/' + env.GITHUB_RUN_ID : null,
    model: config.model.id, claude_code_version: config.model.claude_code_version,
    started_at: now.toISOString()
  };
  if (!/^[0-9a-f]{40}$/.test(run.code_sha)) throw new SafeError('CODE_SHA_REQUIRED');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(run.id) || !Number.isSafeInteger(run.attempt) || run.attempt < 1) throw new SafeError('INVALID_RUN_ID');
  const context = { schema_version: 1, config, previous, run,
    report_date: dateInZone(now, config.timezone), as_of: env.AS_OF || null };
  await saveJson(dir, 'context.json', context);
  return context;
}

export async function collectRun({ env = process.env, now = new Date(), google = collectGoogle, technical = collectTechnical } = {}) {
  const dir = workDirectory(env), context = await readJson(dir, 'context.json');
  const data = await google(context.config, { env, now, asOf: context.as_of || undefined });
  const pageData = await technical(context.config, data.seo, context.previous.site_checks, { now });
  const sources = [...data.sources, pageData.source];
  const report = {
    schema_version: 1,
    site: { id: context.config.id, name: context.config.name, url: context.config.url, timezone: context.config.timezone },
    generated_at: now.toISOString(), report_date: context.report_date,
    report_status: sources.every(s => s.status === 'ok') ? 'complete' : 'limited',
    run: context.run, sources, seo: data.seo, analytics: data.analytics,
    site_checks: pageData.site_checks, evidence: [...data.evidence, ...pageData.evidence],
    history: { index_url: `https://github.com/${context.config.archive.repository}/tree/${REPORTS_BRANCH}/runs`,
      previous_report_url: context.previous.latest?.report_url || null }
  };
  validateFacts(report);
  await saveJson(dir, 'facts.json', report);
  return report;
}

export function makeSummary(report) {
  return { schema_version: 1, report_date: report.report_date, data_through: report.seo.data_through,
    source_status: report.sources.map(s => ({ id: s.id, status: s.status, data_through: s.data_through })),
    summary: report.insights.summary, actions: report.insights.actions,
    comparisons: report.seo.comparisons, code_sha: report.run.code_sha,
    run_id: report.run.id, model: report.run.model };
}

export async function analyzeRun({ env = process.env, analyzer = analyzeReport, renderer = renderReport, markdown = renderMarkdown } = {}) {
  const dir = workDirectory(env), context = await readJson(dir, 'context.json');
  const facts = validateFacts(await readJson(dir, 'facts.json'));
  const result = await analyzer(facts, context.previous, context.config, { root: ROOT, workDir: join(dir, 'model'), env });
  const report = { ...facts, insights: result.insights, model_usage: result.usage };
  const html = renderer(report), md = markdown(report);
  if (typeof html !== 'string' || !html.toLowerCase().includes('<!doctype html>') || !html.includes('</html>')) throw new SafeError('REPORT_HTML_INVALID');
  const output = join(dir, 'output');
  await initializeDirectory(output);
  const files = {
    'report.html': html,
    'report.md': md,
    'report.json': json(report),
    'metrics.json': json({ schema_version: 1, sources: report.sources, seo: report.seo, analytics: report.analytics, site_checks: report.site_checks, evidence: report.evidence }),
    'analysis.json': json({ insights: result.insights, usage: result.usage }),
    'run.json': json({ ...context.run, status: 'completed', report_date: context.report_date,
      data_through: report.seo.data_through, report_status: report.report_status,
      completed_at: new Date().toISOString(), source_status: report.sources })
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(output, name), content, { mode: 0o600 });
  await saveJson(dir, 'state.json', { summary: makeSummary(report), site_checks: report.site_checks });
  await saveJson(dir, 'ready.json', { status: 'completed', report_date: context.report_date, run_id: context.run.id,
    archive_status: report.sources.some(source => source.status === 'error') ? 'failed' : 'completed' });
  return report;
}

export async function publishRun({ env = process.env, archive = archiveRun } = {}) {
  const dir = workDirectory(env), context = await readJson(dir, 'context.json');
  const ready = await readJson(dir, 'ready.json');
  if (ready.status !== 'completed' || ready.run_id !== context.run.id) throw new SafeError('REPORT_NOT_READY');
  const state = await readJson(dir, 'state.json'), files = {};
  for (const name of ['report.html', 'report.md', 'report.json', 'metrics.json', 'analysis.json', 'run.json']) files[name] = await readFile(join(dir, 'output', name), 'utf8');
  const result = await archive({ ...archiveOptions(context.config, env), report_date: context.report_date,
    run_id: context.run.id, attempt: context.run.attempt, code_sha: context.run.code_sha, files,
    ...(ready.archive_status === 'failed' ? {} : { state }), status: ready.archive_status || 'completed' });
  await saveJson(dir, 'published.json', result);
  if (ready.archive_status === 'failed') throw new SafeError('REPORT_CONFIGURED_SOURCE_FAILED');
  return result;
}

export async function recordFailure({ env = process.env, archive = archiveRun } = {}) {
  const dir = workDirectory(env);
  let context;
  try { context = await readJson(dir, 'context.json'); } catch { return { status: 'not_prepared' }; }
  try { await readJson(dir, 'published.json'); return { status: 'already_published' }; } catch { /* no success marker */ }
  // If generation completed but publication failed, retry those exact bytes.
  try { await readJson(dir, 'ready.json'); return await publishRun({ env, archive }); }
  catch (error) { if (error.code !== 'RUN_STATE_MISSING_OR_INVALID') throw error; }
  let failure;
  try { failure = await readJson(dir, 'failure.json'); } catch { failure = { stage: 'unknown', code: 'RUN_INTERRUPTED' }; }
  return archive({ ...archiveOptions(context.config, env), report_date: context.report_date,
    run_id: context.run.id, attempt: context.run.attempt, code_sha: context.run.code_sha,
    files: { 'run.json': json({ ...context.run, status: 'failed', report_date: context.report_date,
      failure, finished_at: new Date().toISOString() }) }, status: 'failed' });
}

export async function saveFailure(stage, error, env = process.env) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
  try { await saveJson(workDirectory(env), 'failure.json', { stage, code, recorded_at: new Date().toISOString() }); } catch { /* no verified work directory */ }
}
