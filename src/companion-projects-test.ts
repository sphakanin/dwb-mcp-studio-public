import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  allowedRoots,
  projectHomes,
  safeProjectName,
  assertAllowedDirectory,
  createStarterProject,
} from './companion-projects.js';
import { CoreStore } from './core-store.js';
import { WorkspaceStore } from './workspace-store.js';

const tmp = await mkdtemp(join(tmpdir(), 'dwb-companion-project-'));
try {
  const projects = join(tmp, 'project-home');
  const repository = join(tmp, 'repo');
  const outside = join(tmp, 'outside');
  await mkdir(projects);
  await mkdir(repository);
  await mkdir(join(repository, '.git'));
  await mkdir(outside);
  const policy = join(tmp, 'policy.json');
  await writeFile(policy, JSON.stringify({ allowedDirectories: [projects, repository] }));
  const roots = await allowedRoots(policy);
  assert.equal(roots.length, 2);
  const homes = await projectHomes(roots);
  assert.equal(homes.length, 1, 'A source repository is not a project home.');
  assert.equal(homes[0].name, 'project-home');
  assert.equal(safeProjectName('  Launch-Site  '), 'Launch-Site');
  for (const value of ['../escape', 'CON', 'COM1', '.git', 'hello/a', 'foo.', 'a'.repeat(70)]) {
    assert.throws(() => safeProjectName(value), /Project name/);
  }
  assert.rejects(assertAllowedDirectory(outside, roots), /outside DWB/);
  assert.equal(await assertAllowedDirectory(projects, roots), await realpath(projects));
  const created = await createStarterProject({
    homeId: homes[0].id,
    projectName: 'Launch-Site',
    kind: 'web',
    homes,
  });
  assert.equal(created.directory, join(await realpath(projects), 'Launch-Site'));
  assert.match(await readFile(join(created.directory, 'README.md'), 'utf8'), /Launch-Site/);
  assert.match(await readFile(join(created.directory, 'index.html'), 'utf8'), /ChatGPT/);
  await assert.rejects(
    createStarterProject({
      homeId: homes[0].id,
      projectName: 'Launch-Site',
      kind: 'blank',
      homes,
    }),
    /EEXIST/,
    'Never overwrite existing project directories.',
  );
  await assert.rejects(
    createStarterProject({
      homeId: 'untrusted-home',
      projectName: 'escape',
      kind: 'web',
      homes,
    }),
    /approved project home/,
  );

  const db = new CoreStore(join(tmp, 'workspaces.db'));
  try {
    const workspaces = new WorkspaceStore(db);
    const active = await workspaces.register({ path: created.directory });
    const related = await workspaces.register({ path: outside });
    workspaces.bindKnown('chat-a', active);
    assert.equal(workspaces.addRelated('chat-a', related.id)[0].id, related.id);
    assert.equal(workspaces.related('chat-b').length, 0, 'References must be session scoped.');
    assert.equal(workspaces.related('chat-a').length, 1);
    assert.throws(() => workspaces.addRelated('chat-a', active.id), /active workspace/);
    assert.equal(workspaces.removeRelated('chat-a', related.id).length, 0);
  } finally {
    db.close();
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
console.log(
  'COMPANION_PROJECTS_TEST_PASS: approved home, creation, no traversal, policy boundary, related per session',
);
