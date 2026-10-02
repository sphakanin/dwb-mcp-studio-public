import { resolve } from 'node:path';
import { CoreStore } from '../dist/core-store.js';
import { WorkspaceStore } from '../dist/workspace-store.js';
import { SkillStore } from '../dist/skill-store.js';
import {
  RECOMMENDED_SKILLS,
  installGitHubSkill,
  installRecommendedSkill,
} from '../dist/skill-sources.js';

function policy(value) {
  if (value === 'auto' || value === 'ask' || value === 'manual') return value;
  throw new Error('Policy must be auto, ask, or manual.');
}

const command = process.argv[2] || 'snapshot';
const args = process.argv.slice(3);
const core = new CoreStore();
const workspaces = new WorkspaceStore(core);
const skills = new SkillStore();

try {
  let result;
  if (command === 'catalog') {
    result = RECOMMENDED_SKILLS;
  } else if (command === 'snapshot') {
    const workspaceList = workspaces.list();
    result = {
      workspaces: workspaceList,
      skills: skills.list(),
      workspacePolicies: Object.fromEntries(
        workspaceList.map((workspace) => [
          workspace.id,
          skills.workspacePolicyOverrides(workspace.id),
        ]),
      ),
      pendingApprovals: skills.pendingApprovals(),
    };
  } else if (command === 'install-local') {
    if (!args[0]) throw new Error('install-local requires a skill directory.');
    result = await skills.installLocal({
      sourceDir: resolve(args[0]),
      defaultPolicy: args[1] ? policy(args[1]) : undefined,
    });
  } else if (command === 'install-github') {
    if (!args[0]) throw new Error('install-github requires a GitHub URL.');
    result = await installGitHubSkill(skills, args[0], {
      defaultPolicy: args[1] ? policy(args[1]) : undefined,
    });
  } else if (command === 'install-recommended') {
    if (!args[0]) throw new Error('install-recommended requires a catalog skill ID.');
    result = await installRecommendedSkill(skills, args[0]);
  } else if (command === 'uninstall') {
    if (!args[0]) throw new Error('uninstall requires a skill ID.');
    result = await skills.uninstall(args[0]);
  } else if (command === 'set-default') {
    result = await skills.setDefaultPolicy(args[0], policy(args[1]));
  } else if (command === 'set-workspace') {
    if (!args[0] || !args[1]) throw new Error('set-workspace requires workspace ID and skill ID.');
    result = await skills.setWorkspacePolicy(args[0], args[1], policy(args[2]));
  } else if (command === 'clear-workspace') {
    result = skills.clearWorkspacePolicy(args[0], args[1]);
  } else if (command === 'approve' || command === 'reject') {
    if (!args[0]) throw new Error(command + ' requires an approval ID.');
    result = skills.decideApproval(args[0], command === 'approve' ? 'approved' : 'rejected');
  } else {
    throw new Error('Unknown skills-admin command: ' + command);
  }
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.error(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  process.exitCode = 1;
} finally {
  skills.close();
  core.close();
}
