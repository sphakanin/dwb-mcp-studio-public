import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { CoreStore } from './core-store.js';
import { WorkspaceStore } from './workspace-store.js';
import { planRootChange, applyRootPlan, readBasePolicy } from './companion-access.js';

const tmp = await mkdtemp(join(tmpdir(), 'dwb-manager-'));
try {
  const approved = join(tmp, 'approved');
  const project = join(approved, 'project');
  const moved = join(approved, 'moved');
  const extra = join(tmp, 'extra');
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(moved, { recursive: true }),
    mkdir(extra),
  ]);
  await writeFile(join(project, 'KEEP.txt'), 'do not delete');
  const policyFile = join(tmp, 'base-policy.json');
  const original = { allowedDirectories: [approved], blockedCommands: ['rm -rf'] };
  await writeFile(policyFile, JSON.stringify(original, null, 2));
  const db = new CoreStore(join(tmp, 'workspaces.db'));
  try {
    const store = new WorkspaceStore(db);
    const entry = await store.register({ path: project });
    store.bindKnown('chat-active', entry);
    assert.throws(() => store.archive(entry.id, 'admin'), /still bound/);
    assert.throws(() => store.unbind('chat-active'), /DWB_WORKSPACE_LOCKED/);
    // Simulate broker retention cleanup, never an in-chat Unbind operation.
    db.run('DELETE FROM session_workspace_bindings WHERE session_id=?', ['chat-active']);
    store.addRelated('chat-other', entry.id);
    assert.throws(() => store.archive(entry.id, 'admin'), /still bound/);
    store.removeRelated('chat-other', entry.id);
    assert.equal(store.archive(entry.id, 'admin').archivedAt !== null, true);
    assert.equal(store.list()[0].archivedAt !== null, true);
    await assert.rejects(store.resolveBinding({ workspace_id: entry.id }, 'chat-test'), /archived/);
    assert.throws(() => store.addRelated('chat-other', entry.id), /Archived/);
    assert.equal(store.restore(entry.id, 'admin').archivedAt, null);
    assert.equal((await store.relink(entry.id, moved, 'admin')).id, entry.id);
    assert.equal(store.exact(entry.id).root, await realpath(moved));
    const another = await store.register({ path: project });
    await assert.rejects(store.relink(entry.id, project, 'admin'), /already registered/);
    assert.equal(store.exact(entry.id).root, await realpath(moved));
    store.archive(entry.id, 'admin');
    assert.equal(store.unregister(entry.id, 'admin').unregistered, entry.id);
    assert.throws(() => store.exact(entry.id), /Unknown workspace ID/);
    assert.equal((await stat(join(project, 'KEEP.txt'))).isFile(), true);
    const events = db.query<{ type: string }>('SELECT type FROM workspace_events ORDER BY id');
    for (const event of ['archived', 'restored', 'relinked', 'unregistered'])
      assert.ok(
        events.some((row) => row.type === event),
        event,
      );
    assert.ok(store.exact(another.id));
    const policyBefore = await readBasePolicy(policyFile);
    const add = await planRootChange('root_add', extra, store.list(), policyFile);
    assert.equal((await readBasePolicy(policyFile)).revision, policyBefore.revision);
    await applyRootPlan(add, policyFile);
    const policyAfter = JSON.parse(await readFile(policyFile, 'utf8'));
    assert.equal(policyAfter.allowedDirectories.length, 2);
    assert.deepEqual(policyAfter.blockedCommands, ['rm -rf']);
    await assert.rejects(applyRootPlan(add, policyFile), /changed since review/);
    const remove = await planRootChange('root_remove', approved, store.list(), policyFile);
    assert.ok(remove.affected.some((w) => w.id === another.id));
    await applyRootPlan(remove, policyFile);
    await assert.rejects(
      planRootChange('root_remove', extra, store.list(), policyFile),
      /last allowed/,
    );
    await assert.rejects(
      planRootChange('root_add', parse(tmp).root, [], policyFile),
      /excessive access/,
    );
    assert.equal((await readBasePolicy(policyFile)).roots.length, 1);
  } finally {
    db.close();
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
console.log(
  'COMPANION_MANAGER_TEST_PASS: archive, restore, unregister, relink, blocked references, root review and revision',
);
