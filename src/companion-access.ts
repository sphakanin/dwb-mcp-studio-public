import { createHash, randomUUID } from 'node:crypto';
import { copyFile, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, parse, resolve } from 'node:path';
import { pathWithin, type WorkspaceView } from './workspace-store.js';
import { physicalPath } from './file-observer.js';

export type RootOperation = 'root_add' | 'root_remove';
type Policy = {
  path: string;
  bytes: Buffer;
  config: Record<string, unknown>;
  roots: string[];
  revision: string;
};
export type RootPlan = {
  operation: RootOperation;
  path: string;
  rootsAfter: string[];
  revision: string;
  affected: Array<{ id: string; name: string }>;
};

export async function readBasePolicy(policyPath = process.env.DWB_BASE_DC_CONFIG): Promise<Policy> {
  if (!policyPath || !isAbsolute(policyPath)) throw new Error('DWB base policy is not configured.');
  const path = resolve(policyPath);
  const bytes = await readFile(path);
  const config = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  if (
    !Array.isArray(config.allowedDirectories) ||
    !config.allowedDirectories.length ||
    config.allowedDirectories.some((entry) => typeof entry !== 'string' || !isAbsolute(entry))
  )
    throw new Error('Base policy must contain a nonempty list of absolute allowedDirectories.');
  return {
    path,
    bytes,
    config,
    roots: config.allowedDirectories as string[],
    revision: createHash('sha256').update(bytes).digest('hex'),
  };
}

function pathEquals(a: string, b: string): boolean {
  return physicalPath(a) === physicalPath(b);
}
function safeWithin(root: string, path: string): boolean {
  try {
    return pathWithin(root, path);
  } catch {
    return false;
  }
}
export async function planRootChange(
  operation: RootOperation,
  requestedPath: string,
  workspaces: WorkspaceView[],
  policyPath?: string,
): Promise<RootPlan> {
  const policy = await readBasePolicy(policyPath);
  if (!isAbsolute(requestedPath)) throw new Error('Choose an absolute directory.');
  let target: string;
  if (operation === 'root_add') {
    target = await realpath(requestedPath);
    if (!(await stat(target)).isDirectory()) throw new Error('Allowed root must be a directory.');
    if (pathEquals(target, parse(target).root) || pathEquals(target, homedir()))
      throw new Error('Selecting a filesystem or user-home root would grant excessive access.');
    if (policy.roots.some((root) => pathEquals(root, target)))
      throw new Error('This directory is already allowed.');
  } else if (operation === 'root_remove') {
    const match = policy.roots.find((root) => pathEquals(root, requestedPath));
    if (!match) throw new Error('Allowed root is not registered in the policy.');
    target = match;
    if (policy.roots.length <= 1) throw new Error('The last allowed directory cannot be removed.');
  } else {
    throw new Error('Unsupported root change.');
  }
  const rootsAfter =
    operation === 'root_add'
      ? [...policy.roots, target]
      : policy.roots.filter((root) => !pathEquals(root, target));
  const affected =
    operation === 'root_remove'
      ? workspaces
          .filter((w) => !rootsAfter.some((root) => safeWithin(root, w.root)))
          .filter((w) => policy.roots.some((root) => safeWithin(root, w.root)))
          .map((w) => ({ id: w.id, name: w.name }))
      : [];
  return { operation, path: target, rootsAfter, revision: policy.revision, affected };
}
export async function applyRootPlan(
  plan: RootPlan,
  policyPath?: string,
): Promise<{ previousRevision: string; revision: string; backupPath: string }> {
  const latest = await readBasePolicy(policyPath);
  if (latest.revision !== plan.revision)
    throw new Error('Base policy changed since review. Refresh and review again.');
  // Recompute the operation from the currently persisted source, never trust a client-provided plan.
  const checked = await planRootChange(plan.operation, plan.path, [], policyPath);
  if (JSON.stringify(checked.rootsAfter) !== JSON.stringify(plan.rootsAfter))
    throw new Error('The proposed root set has changed. Review again.');
  const updated = { ...latest.config, allowedDirectories: plan.rootsAfter };
  if (!plan.rootsAfter.length) throw new Error('Empty allowedDirectories would grant full access.');
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
  const backupPath = latest.path + '.' + stamp + '.' + randomUUID().slice(0, 8) + '.bak';
  const tempPath = latest.path + '.' + randomUUID() + '.tmp';
  await copyFile(latest.path, backupPath);
  try {
    await writeFile(tempPath, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const verify = await readBasePolicy(policyPath);
    if (verify.revision !== plan.revision) throw new Error('Base policy changed while saving.');
    await rename(tempPath, latest.path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
  return {
    previousRevision: plan.revision,
    revision: (await readBasePolicy(policyPath)).revision,
    backupPath,
  };
}

export function displayRootStatus(root: string): string {
  return resolve(root);
}
