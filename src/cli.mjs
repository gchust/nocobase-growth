import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadConfig, SafeError } from './config.mjs';
import { ROOT, preflight, prepareRun, collectRun, analyzeRun, publishRun, recordFailure, saveFailure } from './pipeline.mjs';
import { writeDemo } from './demo.mjs';

const commands = { preflight, prepare: prepareRun, collect: collectRun, analyze: analyzeRun, publish: publishRun, failure: recordFailure };

export async function main(args = process.argv.slice(2), env = process.env, output = process.stdout) {
  const command = args[0] || '';
  if (args.length > 1 || !['demo', 'run', ...Object.keys(commands)].includes(command)) {
    output.write('Usage: node src/cli.mjs demo|preflight|prepare|collect|analyze|publish|failure|run\n');
    return 2;
  }
  let stage = command;
  try {
    if (command === 'run' && !env.GROWTH_WORK_DIR) env = { ...env, GROWTH_WORK_DIR: await mkdtemp(join(tmpdir(), 'nocobase-growth-')) };
    if (command === 'demo') {
      const config = await loadConfig(join(ROOT, 'sites/nocobase.json'), { requireArchive: false });
      await writeDemo(config, join(ROOT, '.work/demo'));
      output.write('Synthetic demo generated at .work/demo/report.html (no real data or API calls).\n');
    } else if (command === 'run') {
      for (const step of ['prepare', 'collect', 'analyze', 'publish']) {
        stage = step;
        await commands[step]({ env });
        output.write('Growth stage ' + step + ': completed.\n');
      }
    } else {
      await commands[command]({ env });
      output.write('Growth stage ' + command + ': completed.\n');
    }
    return 0;
  } catch (error) {
    await saveFailure(stage, error, env);
    // Never print the provider/agent response, error.message, stack, or values.
    // Only known setup codes are useful before a private run can be recorded.
    const setupCodes = new Set(['CONFIG_REPORTS_REPOSITORY_ID_REQUIRED', 'GOOGLE_CREDENTIALS_REQUIRED',
      'MODEL_CREDENTIALS_REQUIRED', 'ARCHIVE_CREDENTIAL_MISSING', 'CODE_SHA_REQUIRED']);
    const reason = setupCodes.has(error?.code) ? error.code : 'PRIVATE_DETAILS_OR_SETUP_GUIDE';
    output.write('Growth stage ' + stage + ': failed (' + reason + ').\n');
    if (command === 'run') {
      try { await recordFailure({ env }); } catch { output.write('Private archive: unavailable. No public fallback.\n'); }
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
