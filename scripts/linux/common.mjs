import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { shellQuote } from '../posix-common.mjs';

export function linuxDataDir(env = process.env) {
  const base = env.XDG_DATA_HOME || resolve(homedir(), '.local', 'share');
  const data = env.DWB_DATA_DIR || resolve(base, 'DWB-MCP-Studio');
  if (!isAbsolute(base) || !isAbsolute(data))
    throw new Error('Data directories must be absolute paths.');
  return resolve(data);
}
export function validateTunnelId(value) {
  if (typeof value !== 'string' || !/^tunnel_[A-Za-z0-9_-]+$/.test(value))
    throw new Error('Provide a Tunnel ID beginning with tunnel_.');
  return value;
}
export function validateApiKey(value) {
  const key = value.trim();
  if (!key || key.length > 8192 || /[\r\n\0]/.test(key))
    throw new Error('Provide a valid single-line API key.');
  return key;
}
export async function readApiKey(path) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new Error('The API key file must be an absolute path.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 8193)
      throw new Error('The API key file must be a small regular file.');
    if (
      process.platform !== 'win32' &&
      (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    )
      throw new Error(
        'The API key file must belong to this user with mode 600 (chmod 600 <file>).',
      );
    return validateApiKey(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}
export function tunnelProfile({ root, data, node = process.execPath, tunnelId }) {
  return {
    config_version: 1,
    control_plane: {
      base_url: 'https://api.openai.com',
      tunnel_id: validateTunnelId(tunnelId),
      api_key: 'env:DWB_TUNNEL_RUNTIME_KEY',
    },
    health: { listen_addr: '127.0.0.1:0', url_file: resolve(data, 'tunnel-linux/health.url') },
    admin_ui: { open_browser: false },
    log: { level: 'info', format: 'json', file: resolve(data, 'tunnel-linux/tunnel.log') },
    mcp: {
      commands: [
        {
          channel: 'main',
          command: [node, resolve(root, 'scripts/tunnel-mcp.mjs')].map(shellQuote).join(' '),
        },
      ],
    },
  };
}
