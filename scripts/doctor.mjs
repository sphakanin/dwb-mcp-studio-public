import { access } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { configPath, readConfig, validateConfig } from './config.mjs';
import { dataDir } from '../dist/paths.js';
import { brokerEndpoint } from '../dist/broker-protocol.js';

// Probe only: diagnosing an installation must not launch a broker or worker.
async function runtimeStatus() {
  return new Promise((resolve) => {
    const socket = createConnection(brokerEndpoint());
    let buffer = '';
    const finish = (result) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ state: 'unresponsive', message: 'Broker did not respond within 2 seconds.' }),
      2000,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () =>
      socket.write(JSON.stringify({ id: 'doctor', method: 'ping' }) + '\n'),
    );
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 65536)
        return finish({ state: 'unresponsive', message: 'Unexpected broker response.' });
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end));
        if (message.id !== 'doctor' || !message.ok || !message.result?.pong) throw new Error();
        finish({ state: 'running', ...message.result.broker });
      } catch {
        finish({ state: 'unresponsive', message: 'Unexpected broker response.' });
      }
    });
    socket.on('error', (error) =>
      finish({
        state: ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'stopped' : 'unreachable',
        message: ['ENOENT', 'ECONNREFUSED'].includes(error.code)
          ? 'Ready to start automatically when your MCP client connects.'
          : error.message,
      }),
    );
    socket.on('end', () =>
      finish({ state: 'unresponsive', message: 'Broker closed the diagnostic connection.' }),
    );
  });
}

try {
  if (!['win32', 'darwin', 'linux'].includes(process.platform))
    throw new Error('Supported on Windows, macOS and Linux.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16))
    throw new Error('Install Node.js 22.16 or newer, then rerun Setup.');
  await access(new URL('../dist/index.js', import.meta.url));
  const config = await validateConfig(await readConfig());
  console.log(
    JSON.stringify(
      {
        ok: true,
        node: process.version,
        configFile: configPath(),
        dataDirectory: dataDir(),
        brokerEndpoint: brokerEndpoint(),
        ...config,
        runtime: await runtimeStatus(),
        isolation: 'Per-worker config via an in-memory loader; external files are unchanged.',
        transport:
          process.platform === 'linux'
            ? 'Ubuntu/Linux: local stdio via mcp-client.json, or a managed OpenAI tunnel with a user systemd service. See docs/UBUNTU-TH.md.'
            : process.platform === 'darwin'
              ? 'macOS candidate: open DWB MCP Studio.app for managed tunnel, or use mcp-client.json for local stdio. See docs/MACOS-PREVIEW-TH.md.'
              : 'Local stdio with the managed OpenAI tunnel. Open DWB MCP Studio.exe, enter your Tunnel ID and API key, then select Start MCP.',
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`DWB doctor failed: ${error.message}`);
  process.exitCode = 1;
}
