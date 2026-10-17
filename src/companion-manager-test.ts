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
    assert.deepEqual(store.presentationSettings(), { enabled: false, demoWorkspaceIds: [] });
    assert.throws(() => store.setPresentationEnabled(true, [entry.id]), /Choose at least one/);
    assert.throws(() => store.configurePresentation(['nonexistent']), /unknown registered/);
    store.configurePresentation([entry.id, entry.id]);
    assert.deepEqual(store.presentationSettings().demoWorkspaceIds, [entry.id]);
    assert.equal(store.setPresentationEnabled(true, [entry.id]).enabled, true);
    assert.throws(() => store.configurePresentation([]), /Exit Presentation Mode/);
    const reopened = new CoreStore(join(tmp, 'workspaces.db'));
    try {
      assert.deepEqual(new WorkspaceStore(reopened).presentationSettings(), {
        enabled: true,
        demoWorkspaceIds: [entry.id],
      });
    } finally {
      reopened.close();
    }
    assert.equal(store.setPresentationEnabled(false).enabled, false);
    assert.deepEqual(store.configurePresentation([]).demoWorkspaceIds, []);
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

    // Multi-workspace allowlist and presentation toggles must not mutate Registry,
    // session bindings, references, events, filesystem contents, or access policy.
    const captureState = () => ({
      registry: db.query('SELECT id,root_path,name FROM workspaces ORDER BY id'),
      bindings: db.query('SELECT * FROM session_workspace_bindings ORDER BY session_id'),
      references: db.query('SELECT * FROM companion_related_workspaces ORDER BY session_id'),
      events: db.query('SELECT * FROM workspace_events ORDER BY id'),
    });
    const dataBefore = captureState();
    const policyBeforePresentation = await readFile(policyFile, 'utf8');
    store.configurePresentation([another.id, entry.id, another.id]);
    assert.deepEqual(store.presentationSettings().demoWorkspaceIds, [another.id, entry.id]);
    assert.throws(() => store.setPresentationEnabled(true, []), /Choose at least one/);
    assert.equal(store.setPresentationEnabled(true, [another.id]).enabled, true);
    const newChat = new WorkspaceStore(db);
    assert.deepEqual(newChat.presentationSettings().demoWorkspaceIds, [another.id, entry.id]);
    assert.deepEqual(captureState(), dataBefore);
    assert.equal(await readFile(policyFile, 'utf8'), policyBeforePresentation);
    assert.equal((await stat(join(project, 'KEEP.txt'))).isFile(), true);
    store.archive(entry.id, 'admin');
    assert.equal(
      store.presentationSettings().enabled,
      true,
      'Mode does not block direct Registry semantics',
    );
    assert.equal(store.unregister(entry.id, 'admin').unregistered, entry.id);
    assert.throws(() => store.exact(entry.id), /Unknown workspace ID/);
    assert.equal(
      store.presentationSettings().enabled,
      true,
      'Registry mutations do not disable presentation',
    );
    assert.equal(store.setPresentationEnabled(false).enabled, false);
    assert.equal(
      store.exact(another.id).root,
      String(
        (dataBefore.registry as Array<{ id: string; root_path: string }>).find(
          (w) => w.id === another.id,
        )?.root_path,
      ),
      'Presentation must not change the original registered root',
    );
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

    // A corrupt stored allowlist must fail closed, not reveal all workspaces.
    db.run(
      'UPDATE companion_presentation_settings SET enabled=1,demo_workspace_ids=? WHERE setting_id=1',
      ['not valid JSON'],
    );
    assert.deepEqual(store.presentationSettings(), { enabled: true, demoWorkspaceIds: [] });
  } finally {
    db.close();
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
console.log(
  'COMPANION_MANAGER_TEST_PASS: archive, restore, unregister, relink, blocked references, root review and revision',
);
