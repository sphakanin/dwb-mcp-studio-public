import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SkillStore } from './skill-store.js';

const temp = await mkdtemp(join(tmpdir(), 'dwb-comfy-skill-'));
const source = resolve('skills', 'comfyui-setup');
const store = new SkillStore({
  dbPath: join(temp, 'skills.db'),
  libraryRoot: join(temp, 'skill-library'),
});
try {
  const skill = await store.installLocal({
    sourceDir: source,
    defaultPolicy: 'ask',
    sourceType: 'local',
  });
  assert.equal(skill.id, 'comfyui-setup');
  assert.equal(skill.policy, 'ask');
  assert.ok(skill.description.includes('ComfyUI'));
  assert.equal(store.list('test-workspace').length, 1);
  const first = store.activate({
    sessionId: 'test-chat',
    workspaceId: 'test-workspace',
    skillId: 'comfyui-setup',
  });
  assert.equal(first.status, 'approval_required', 'Local Skill must not activate by default.');
  assert.equal(store.isActivated('test-chat', 'test-workspace', 'comfyui-setup'), false);
  await assert.rejects(
    store.readActivatedSkillFile(
      'test-chat',
      'test-workspace',
      'comfyui-setup',
      'scripts/Install-ComfyUIPortable.ps1',
    ),
    /DWB_SKILL_NOT_ACTIVE/,
  );
  const preflight = await store.readSkillFile('comfyui-setup', 'scripts/Preflight-ComfyUI.ps1');
  const install = await store.readSkillFile('comfyui-setup', 'scripts/Install-ComfyUIPortable.ps1');
  assert.ok(preflight.includes('changesMade'));
  assert.ok(install.includes('UserApproved'));
  assert.ok(install.includes('ApprovedSha256'));
  const isolated = await store.readSkillFile('comfyui-setup', 'scripts/Start-ComfyUI-Isolated.ps1');
  assert.ok(isolated.includes('--listen'));
  assert.ok(isolated.includes('--base-directory'));
  assert.ok(isolated.includes('--models-directory'));
  assert.ok(isolated.includes('otherComfyInstanceCount'));
  for (const key of ['CUDA_CACHE_PATH', 'TRITON_CACHE_DIR', 'TORCHINDUCTOR_CACHE_DIR']) {
    assert.ok(isolated.includes(key), key + ' should be included in the local skill package');
  }
  assert.ok(isolated.includes('$psi.EnvironmentVariables[$cacheVariable]'));
  console.log(
    'COMFYUI_SKILL_PACKAGE_TEST_PASS: local package installs, ASK approval gate, scripts included',
  );
} finally {
  store.close();
  await rm(temp, { recursive: true, force: true });
}
