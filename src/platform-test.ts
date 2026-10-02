import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CoreStore } from './core-store.js';
import { WorkspaceStore } from './workspace-store.js';
import { sameRuntimePath } from './runtime-identity.js';
import { dataDir, defaultWorkerShell } from './paths.js';

test('worker shells match the operating system', () => {
  assert.equal(defaultWorkerShell('win32'), 'powershell.exe');
  assert.equal(defaultWorkerShell('darwin'), '/bin/zsh');
  assert.equal(defaultWorkerShell('linux'), '/bin/bash');
});
test(
  'Linux data follows XDG_DATA_HOME and explicit DWB_DATA_DIR',
  { skip: process.platform !== 'linux' },
  () => {
    const previous = { xdg: process.env.XDG_DATA_HOME, data: process.env.DWB_DATA_DIR };
    try {
      delete process.env.DWB_DATA_DIR;
      process.env.XDG_DATA_HOME = '/tmp/dwb-xdg-test';
      assert.equal(dataDir(), '/tmp/dwb-xdg-test/DWB-MCP-Studio');
      process.env.DWB_DATA_DIR = '/tmp/dwb-data-test';
      assert.equal(dataDir(), '/tmp/dwb-data-test');
    } finally {
      for (const [key, value] of [
        ['XDG_DATA_HOME', previous.xdg],
        ['DWB_DATA_DIR', previous.data],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test('runtime identity respects platform case rules', () => {
  const path = resolve('RuntimePath');
  assert.ok(sameRuntimePath(path, path));
  assert.equal(sameRuntimePath(path.toUpperCase(), path), process.platform === 'win32');
  assert.equal(sameRuntimePath(undefined, path), false);
});
test('workspace identity distinguishes physical directories on case-sensitive disks', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'dwb-platform-')));
  const db = new CoreStore(resolve(root, 'workspace.db'));
  try {
    const store = new WorkspaceStore(db);
    const upper = resolve(root, 'Project'),
      lower = resolve(root, 'project');
    await mkdir(upper);
    await mkdir(lower, { recursive: true });
    const a = await store.register({ path: upper, name: 'Upper' });
    const b = await store.register({ path: lower, name: 'Lower' });
    const [upperInfo, lowerInfo] = await Promise.all([stat(upper), stat(lower)]);
    const same = upperInfo.dev === lowerInfo.dev && upperInfo.ino === lowerInfo.ino;
    if (process.platform === 'win32' || same) assert.equal(a.id, b.id);
    else {
      assert.notEqual(a.id, b.id);
      assert.equal(store.resolveRef(upper).id, a.id);
      assert.equal(store.resolveRef(lower).id, b.id);
    }
    if (process.platform !== 'win32') {
      const alias = resolve(root, 'alias');
      await symlink(upper, alias, 'dir');
      assert.equal((await store.register({ path: alias })).id, a.id);
    }
  } finally {
    db.close();
  }
});
test(
  'Mac preview migration preserves workspace data and permits binary root identity',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'dwb-migration-'));
    const path = resolve(dir, 'state.db');
    const previous = new DatabaseSync(path);
    previous.exec(
      "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO workspaces VALUES ('one','First','/Project','then','then');",
    );
    previous.close();
    const migrated = new CoreStore(path);
    try {
      assert.equal(
        migrated.one<{ name: string }>("SELECT name FROM workspaces WHERE id='one'")?.name,
        'First',
      );
      migrated.run("INSERT INTO workspaces VALUES ('two','Second','/project','now','now')");
      assert.equal(migrated.query('SELECT * FROM workspaces').length, 2);
    } finally {
      migrated.close();
    }
  },
);
