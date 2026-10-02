import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function dataDir(): string {
  if (process.platform === 'linux')
    return resolve(
      process.env.DWB_DATA_DIR ||
        resolve(
          process.env.XDG_DATA_HOME || resolve(homedir(), '.local', 'share'),
          'DWB-MCP-Studio',
        ),
    );
  if (process.platform === 'darwin')
    return resolve(
      process.env.DWB_DATA_DIR ||
        resolve(homedir(), 'Library', 'Application Support', 'DWB-MCP-Studio-Mac-Preview'),
    );
  return resolve(
    process.env.DWB_DATA_DIR ||
      resolve(process.env.LOCALAPPDATA || resolve(homedir(), '.local', 'share'), 'DWB-MCP-Studio'),
  );
}
export function runtimeDir(): string {
  return resolve(process.env.DWB_RUNTIME_DIR || resolve(dataDir(), 'runtime'));
}

export function defaultWorkerShell(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'powershell.exe' : platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}
