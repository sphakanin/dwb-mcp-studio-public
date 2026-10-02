import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readConfig, validateConfig } from '../config.mjs';

const config = await validateConfig(await readConfig());
const dir = await realpath(
  await mkdtemp(resolve(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'dwb-mac-test-')),
);
const basePolicy = resolve(dir, 'policy.json');
await writeFile(
  basePolicy,
  JSON.stringify({
    allowedDirectories: [dir],
    telemetryEnabled: false,
    defaultShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh',
  }),
);
// Never inherit production broker, database, policy, or resume identifiers.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !key.startsWith('DWB_'),
  ),
);
Object.assign(env, {
  DWB_DATA_DIR: dir,
  DWB_WORKER_ENTRY: config.workerEntry,
  DWB_BASE_DC_CONFIG: basePolicy,
  DWB_WORKER_CAP: '2',
  DWB_BROKER_PIPE:
    process.platform === 'win32'
      ? `\\\\.\\pipe\\dwb-mac-test-${process.pid}`
      : resolve(dir, 'broker.sock'),
});
const clients = [];
const brokers = new Set();
async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
    cwd: dir,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'mac-preview-test', version: '1' });
  clients.push({ client, transport });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  await client.connect(transport);
  return client;
}
async function status(client) {
  const result = await client.callTool({ name: 'dwb_bridge_status', arguments: {} });
  assert.notEqual(result.isError, true);
  const value = result.structuredContent;
  brokers.add(value.broker.brokerPid);
  return value;
}
try {
  const [a, b] = await Promise.all([connect(), connect()]);
  await Promise.all([a.listTools(), b.listTools()]);
  const [first, second] = await Promise.all([status(a), status(b)]);
  assert.equal(
    first.broker.brokerPid,
    second.broker.brokerPid,
    'Cold starts must share one broker',
  );
  assert.notEqual(first.workerPid, second.workerPid, 'Sessions must have isolated workers');
  const rejectedStop = await new Promise((done, reject) => {
    const socket = createConnection(env.DWB_BROKER_PIPE);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Runtime guard timed out'));
    }, 5000);
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.write(
        JSON.stringify({
          id: 'wrong-runtime',
          method: 'prepare_upgrade',
          params: { expectedRuntime: { version: 'not-this-version', appRoot: dir } },
        }) + '\n',
      ),
    );
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        clearTimeout(timer);
        socket.destroy();
        done(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
      }
    });
  });
  assert.equal(rejectedStop.ok, false);
  assert.match(rejectedStop.error.message, /DWB_RUNTIME_MISMATCH/);
  assert.equal(
    (await status(a)).broker.brokerPid,
    first.broker.brokerPid,
    'An unrelated runtime must not stop the broker',
  );
  const file = resolve(dir, 'hello.txt');
  const written = await a.callTool({
    name: 'write_file',
    arguments: { path: file, content: 'mac-preview-ok\n', mode: 'rewrite' },
  });
  assert.notEqual(written.isError, true, JSON.stringify(written));
  assert.equal(await readFile(file, 'utf8'), 'mac-preview-ok\n');
  assert.notEqual(
    (await a.callTool({ name: 'read_file', arguments: { path: file } })).isError,
    true,
  );
  if (process.platform === 'darwin') {
    const shell = await a.callTool({
      name: 'start_process',
      arguments: { command: 'printf DWB_MAC_SHELL_OK', timeout_ms: 10000 },
    });
    assert.notEqual(shell.isError, true);
    assert.match(JSON.stringify(shell.content), /DWB_MAC_SHELL_OK/);
  }
  process.kill(first.workerPid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 700));
  await a.listTools();
  assert.notEqual((await status(a)).workerPid, first.workerPid);
  process.kill(first.broker.brokerPid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 700));
  await a.listTools();
  const restored = await status(a);
  assert.notEqual(restored.broker.brokerPid, first.broker.brokerPid);
  assert.equal(restored.sessionId, first.sessionId);
  console.log(
    `MAC_PREVIEW_CORE_PASS platform=${process.platform} arch=${process.arch}\nTest files: ${dir}`,
  );
} finally {
  for (const { client, transport } of clients) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
  for (const pid of brokers) {
    try {
      process.kill(pid);
    } catch {}
  }
}
