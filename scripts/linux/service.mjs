import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export function serviceName(data) {
  return `dwb-mcp-studio-${createHash('sha256').update(data).digest('hex').slice(0, 12)}.service`;
}
export function servicePath(data, env = process.env) {
  const base = env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  if (!isAbsolute(base)) throw new Error('XDG_CONFIG_HOME must be an absolute path.');
  return resolve(base, 'systemd/user', serviceName(data));
}
export function systemdQuote(value, executable = false) {
  if (/[\0\r\n]/.test(value)) throw new Error('Service values cannot contain newlines or NUL.');
  let text = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  if (executable) text = text.replaceAll('$', () => '$$');
  return `"${text}"`;
}
export function renderService({ root, data, node = process.execPath }) {
  return `[Unit]
Description=DWB MCP Studio Ubuntu tunnel
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${[node, resolve(root, 'scripts/linux/cli.mjs'), 'tunnel'].map((value) => systemdQuote(value, true)).join(' ')}
Environment=${systemdQuote(`DWB_DATA_DIR=${data}`)} ${systemdQuote(`DWB_CONFIG_FILE=${resolve(data, 'config.json')}`)}
UMask=0077
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}
