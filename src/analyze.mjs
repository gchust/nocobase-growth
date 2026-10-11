import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SafeError } from './config.mjs';
import { validateAnalysis } from './validate.mjs';

export function modelEnvironment(env, config, workDir) {
  const token = env.DEEPSEEK_API_KEY;
  if (!token) throw new SafeError('MODEL_CREDENTIALS_REQUIRED');
  const result = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'SystemRoot']) if (env[key]) result[key] = env[key];
  Object.assign(result, {
    CLAUDE_CONFIG_DIR: join(workDir, 'claude-config'),
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: config.model.provider_base_url,
    ANTHROPIC_MODEL: config.model.id,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.model.id,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.model.id,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model.id,
    CLAUDE_CODE_SUBAGENT_MODEL: config.model.id,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    CI: 'true'
  });
  return result;
}

export function analysisInput(facts, previous) {
  const slimSeo = facts.seo ? { ...facts.seo, daily: facts.seo.daily.slice(-56) } : null;
  if (slimSeo?.movers) {
    slimSeo.movers = Object.fromEntries(Object.entries(slimSeo.movers).map(([window, lists]) => [window,
      Object.fromEntries(Object.entries(lists).map(([key, rows]) => [key, Array.isArray(rows) ? rows.slice(0, 12) : rows]))]));
  }
  const input = {
    site: facts.site, report_date: facts.report_date, sources: facts.sources,
    seo: slimSeo, analytics: facts.analytics, site_checks: facts.site_checks,
    evidence: facts.evidence,
    previous_summary: previous?.summary || null
  };
  const text = JSON.stringify(input);
  if (Buffer.byteLength(text) > 500_000) throw new SafeError('MODEL_INPUT_TOO_LARGE');
  return text;
}

function section(text, heading) {
  const at = text.indexOf('\n## ' + heading + '\n');
  if (at < 0) throw new SafeError('SKILL_SECTION_MISSING');
  const next = text.indexOf('\n## ', at + 4);
  return text.slice(at, next < 0 ? text.length : next);
}

export async function buildSystemPrompt(root) {
  const google = await readFile(join(root, 'vendor/claude-seo/seo-google/SKILL.md'), 'utf8');
  const drift = await readFile(join(root, 'vendor/claude-seo/seo-drift/SKILL.md'), 'utf8');
  const daily = await readFile(join(root, '.claude/skills/nocobase-growth-daily/SKILL.md'), 'utf8');
  return 'SEO reference material follows. It is reference only, not a request to run its commands.\n'
    + section(google, 'Search Console') + section(google, 'GA4 Traffic')
    + section(drift, 'What It Captures') + section(drift, 'How Comparison Works')
    + '\n\nDAILY REPORT TASK AND OUTPUT CONTRACT (apply these rules):\n' + daily;
}

export function executeCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    const stdout = [], stderr = [];
    let bytes = 0, failure = null, finished = false, killTimer;
    const terminate = (code) => {
      if (failure) return;
      failure = new SafeError(code);
      try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM'); } catch { /* already stopped */ }
      killTimer = setTimeout(() => { try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
      killTimer.unref();
    };
    const timer = setTimeout(() => terminate('MODEL_TIMEOUT'), options.timeoutMs || 600_000);
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2_000_000) { terminate('MODEL_OUTPUT_TOO_LARGE'); return; }
        if (key === 'stdout') stdout.push(chunk); else stderr.push(chunk);
      });
    }
    child.on('error', () => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer);
      reject(new SafeError('MODEL_PROCESS_UNAVAILABLE'));
    });
    child.stdin.on('error', () => { /* close/error handlers decide final outcome */ });
    child.on('close', code => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer);
      if (failure) reject(failure); else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(options.input || '');
  });
}

export function parseModelResult(text) {
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new SafeError('MODEL_RESPONSE_INVALID'); }
  if (!envelope || envelope.is_error || envelope.type !== 'result' || envelope.subtype !== 'success') throw new SafeError('MODEL_RUN_FAILED');
  if (envelope.permission_denials?.length) throw new SafeError('MODEL_UNEXPECTED_TOOL_REQUEST');
  let insights = envelope.structured_output;
  if (!insights && typeof envelope.result === 'string') {
    try { insights = JSON.parse(envelope.result); } catch { throw new SafeError('MODEL_STRUCTURED_OUTPUT_MISSING'); }
  }
  if (!insights) throw new SafeError('MODEL_STRUCTURED_OUTPUT_MISSING');
  return { insights, usage: {
    input_tokens: envelope.usage?.input_tokens ?? null,
    output_tokens: envelope.usage?.output_tokens ?? null,
    cache_read_input_tokens: envelope.usage?.cache_read_input_tokens ?? null,
    duration_ms: envelope.duration_ms ?? null,
    cost_estimate_usd: envelope.total_cost_usd ?? null,
    cost_note: 'Claude Code estimate; verify charges with the DeepSeek provider.'
  } };
}

export async function analyzeReport(facts, previous, config, { root, workDir, env = process.env, execute = executeCaptured } = {}) {
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const childEnv = modelEnvironment(env, config, workDir);
  const version = await execute('claude', ['--version'], { cwd: workDir, env: childEnv, timeoutMs: 15_000 });
  if (version.code !== 0 || !version.stdout.trim().startsWith(config.model.claude_code_version + ' ')) throw new SafeError('MODEL_CLI_VERSION_MISMATCH');
  const systemPath = join(workDir, 'system-prompt.txt');
  const schema = JSON.parse(await readFile(join(root, 'schemas/analysis.schema.json'), 'utf8'));
  await writeFile(systemPath, await buildSystemPrompt(root)
    + '\nReturn exactly one JSON object, no fences, matching this schema:\n' + JSON.stringify(schema), { mode: 0o600 });
  const args = [
    '--bare', '--print', '--output-format', 'json',
    '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--no-session-persistence', '--model', config.model.id,
    '--max-turns', String(config.model.max_turns), '--system-prompt-file', systemPath
  ];
  const result = await execute('claude', args, { cwd: workDir, env: childEnv,
    input: analysisInput(facts, previous), timeoutMs: config.model.timeout_seconds * 1000 });
  if (result.code !== 0) throw new SafeError('MODEL_PROCESS_FAILED');
  const parsed = parseModelResult(result.stdout);
  validateAnalysis(parsed.insights, schema, facts, config);
  return parsed;
}
