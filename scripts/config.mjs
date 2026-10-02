import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { dataDir } from '../dist/paths.js';
import { externalWorker } from '../dist/external-worker.js';

export const configPath = () =>
  resolve(process.env.DWB_CONFIG_FILE || resolve(dataDir(), 'config.json'));
export async function readConfig() {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read config: ${error.message}`);
  }
}
export async function validateConfig(config) {
  const worker = externalWorker(process.env.DWB_WORKER_ENTRY || config.workerEntry);
  const workspace = process.env.DWB_WORKSPACE || config.workspace;
  if (!workspace || !isAbsolute(workspace) || !(await stat(workspace)).isDirectory())
    throw new Error(
      'Choose an existing absolute workspace directory using Setup, scripts/configure.mjs, or DWB_WORKSPACE.',
    );
  const workerCap = Number(process.env.DWB_WORKER_CAP || config.workerCap || 4);
  if (!Number.isInteger(workerCap) || workerCap < 1 || workerCap > 64)
    throw new Error('workerCap must be an integer from 1 to 64.');
  const basePolicy = process.env.DWB_BASE_DC_CONFIG || config.basePolicy;
  if (basePolicy) {
    if (!isAbsolute(basePolicy)) throw new Error('basePolicy must be an absolute path.');
    const policy = JSON.parse(await readFile(basePolicy, 'utf8'));
    if (
      !Array.isArray(policy.allowedDirectories) ||
      policy.allowedDirectories.some((p) => typeof p !== 'string' || !isAbsolute(p))
    )
      throw new Error('basePolicy.allowedDirectories must contain absolute directory paths.');
  }
  return {
    workerEntry: worker.entry,
    workspace: resolve(workspace),
    workerCap,
    basePolicy,
    version: worker.version,
  };
}
export function applyConfig(config) {
  process.env.DWB_WORKER_ENTRY = config.workerEntry;
  process.env.DWB_WORKER_CAP = String(config.workerCap);
  if (config.basePolicy) process.env.DWB_BASE_DC_CONFIG = config.basePolicy;
  process.chdir(config.workspace);
}
