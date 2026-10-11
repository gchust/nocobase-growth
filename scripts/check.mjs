import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const dir of ['src', 'scripts', 'tests']) {
  for (const name of await readdir(join(root, dir))) {
    if (!name.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', join(root, dir, name)], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'JavaScript syntax check failed: ' + dir + '/' + name);
  }
}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.type, 'module');
assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
for (const path of ['schemas/analysis.schema.json', 'sites/nocobase.json', 'vendor/claude-seo/UPSTREAM.json']) JSON.parse(await readFile(join(root, path), 'utf8'));
// These workflows resolve runner paths from RUNNER_TEMP inside shell steps.
// Keeping runner expressions out prevents job-level env evaluation failures.
for (const path of ['ci.yml', 'growth-report.yml']) {
  const contents = await readFile(join(root, '.github/workflows', path), 'utf8');
  assert.doesNotMatch(contents, /\$\{\{[^}]*\brunner\s*(?:\.|\[)/,
    'Resolve runner paths from RUNNER_TEMP inside a step: ' + path);
}
const workflow = await readFile(join(root, '.github/workflows/growth-report.yml'), 'utf8');
for (const forbidden of ['pull_request_target:', 'upload-artifact', 'actions/cache', 'GITHUB_STEP_SUMMARY', 'secrets: inherit', '--dangerously-skip-permissions']) {
  assert.ok(!workflow.includes(forbidden), 'Production workflow contains a prohibited public output or privilege path');
}
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /cancel-in-progress: false/);
assert.match(workflow, /growth-production/);
const skill = await readFile(join(root, '.claude/skills/nocobase-growth-daily/SKILL.md'), 'utf8');
assert.match(skill, /^---\nname: nocobase-growth-daily\ndescription: /);
assert.ok(!skill.includes('[TODO'));
process.stdout.write('Source, workflow boundary, schema and skill checks passed.\n');
