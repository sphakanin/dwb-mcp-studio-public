import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CoreStore } from '../dist/core-store.js';
import { WorkspaceStore } from '../dist/workspace-store.js';
import { SkillStore } from '../dist/skill-store.js';
const root = process.env.DWB_DATA_DIR;
if (!root || !root.includes('dwb-skills-ui-'))
  throw new Error('Isolated Skills UI test directory required');
const core = new CoreStore();
const workspaces = new WorkspaceStore(core);
const skills = new SkillStore();
try {
  const command = process.argv[2];
  if (command === 'seed') {
    for (const name of ['workspace-one', 'workspace-two']) {
      const path = join(root, name);
      await mkdir(path, { recursive: true });
      await workspaces.register({ path, name });
    }
  } else if (command === 'pending') {
    const workspaceId = workspaces.resolveRef('workspace-one').id;
    const requests = ['approve', 'reject'].map((sessionId) => {
      const args = { sessionId, workspaceId, skillId: 'ui-skill' };
      const result = skills.activate(args);
      assert.equal(result.status, 'approval_required');
      return { ...args, approvalId: result.approvalId };
    });
    await writeFile(join(root, 'requests.json'), JSON.stringify(requests));
  } else if (command === 'verify-decisions') {
    const requests = JSON.parse(await readFile(join(root, 'requests.json'), 'utf8'));
    assert.equal(skills.activate(requests[0]).status, 'active');
    assert.equal(skills.activate(requests[1]).status, 'rejected');
  } else if (command === 'verify-uninstalled') {
    assert.equal(skills.list().length, 0);
    assert.equal(skills.pendingApprovals().length, 0);
    for (const workspace of workspaces.list())
      assert.deepEqual(skills.workspacePolicyOverrides(workspace.id), {});
    const requests = JSON.parse(await readFile(join(root, 'requests.json'), 'utf8'));
    assert.equal(skills.isActivated('approve', requests[0].workspaceId, 'ui-skill'), false);
  } else throw new Error('Unknown fixture command');
  console.log('PASS');
} finally {
  skills.close();
  core.close();
}
