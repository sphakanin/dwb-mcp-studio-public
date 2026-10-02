import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDistribution, sourceFiles } from './distribution-check.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const current = await checkDistribution(root);
assert.ok(current.includes('src/index.ts'));
assert.ok(current.includes('docs/UBUNTU-TH.md'));
assert.ok(!current.includes('docs/RECORDING-SKILLS-TH.md'));

const fixture = await mkdtemp(resolve(tmpdir(), 'dwb-distribution-'));
try {
  for (const dir of ['src', 'scripts', 'docs', 'assets', '.github'])
    await mkdir(resolve(fixture, dir), { recursive: true });
  const manifest = {
    files: ['scripts/distribution-files.json', 'src/index.ts', 'docs/guide.md'],
    launchers: ['install.sh'],
    developmentFiles: [],
  };
  await writeFile(resolve(fixture, 'scripts/distribution-files.json'), JSON.stringify(manifest));
  await writeFile(resolve(fixture, 'src/index.ts'), 'export {};');
  await writeFile(resolve(fixture, 'docs/guide.md'), '# Guide\n');
  await writeFile(resolve(fixture, 'install.sh'), '#!/bin/bash\n');
  assert.equal((await sourceFiles(fixture, { launcher: 'install.sh' })).length, 4);

  for (const path of [
    'docs/RECORDING-SKILLS-TH.md',
    'docs/unrelated-project.md',
    'scripts/.env',
    'assets/model.safetensors',
    'src/experiments/task.ts',
  ]) {
    await mkdir(dirname(resolve(fixture, path)), { recursive: true });
    await writeFile(resolve(fixture, path), 'fixture');
    await assert.rejects(sourceFiles(fixture), /unrelated|not in|distributed/);
    await rm(resolve(fixture, path));
    // Remove the now-empty reserved folder so later cases inspect a clean fixture.
    if (path.startsWith('src/experiments/')) await rmdir(resolve(fixture, 'src/experiments'));
  }
  await assert.rejects(sourceFiles(fixture, { launcher: '../private.sh' }), /Unknown.*launcher/);
  await writeFile(
    resolve(fixture, 'scripts/distribution-files.json'),
    JSON.stringify({ ...manifest, developmentFiles: ['engineering/notes.md'] }),
  );
  await assert.rejects(sourceFiles(fixture), /Internal development evidence/);
  await writeFile(resolve(fixture, 'scripts/distribution-files.json'), JSON.stringify(manifest));

  const init = spawnSync('git', ['init', '--quiet', fixture], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(init.status, 0, init.error?.message || init.stderr);
  await writeFile(resolve(fixture, '.env.example'), 'UNRELATED_SERVICE_KEY=\n');
  const add = spawnSync('git', ['-C', fixture, 'add', '.env.example'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(add.status, 0, add.error?.message || add.stderr);
  await assert.rejects(checkDistribution(fixture), /unrelated.*\.env\.example/);
  await rm(resolve(fixture, '.env.example'));
  await checkDistribution(fixture);
  assert.equal(await readFile(resolve(fixture, 'docs/guide.md'), 'utf8'), '# Guide\n');
} finally {
  // Only the isolated temporary fixture created above is removed.
  await rm(fixture, { recursive: true, force: true });
}
console.log('DISTRIBUTION_TEST_PASS: exact source manifest, nested artifacts, private files, Git');
