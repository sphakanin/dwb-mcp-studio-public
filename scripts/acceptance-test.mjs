// Run from an extracted, configured release with isolated DWB_DATA_DIR/DWB_CONFIG_FILE.
// Optional --url must point to a local test tunnel, never a hosted/production connector.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readConfig, validateConfig } from './config.mjs';

const { values } = parseArgs({ options: { url: { type: 'string' } } });
if (!process.env.DWB_DATA_DIR || !process.env.DWB_CONFIG_FILE)
  throw new Error(
    'Use an isolated test data directory and config before running acceptance tests.',
  );
const url = values.url ? new URL(values.url) : null;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  throw new Error('Acceptance tests only support a loopback tunnel URL.');
const config = await validateConfig(await readConfig());
const root = await mkdtemp(resolve(config.workspace, 'acceptance-'));
const alias = `shop-${basename(root)}`;
const aDir = resolve(root, 'shop-a'),
  bDir = resolve(root, 'shop-b');
await Promise.all([mkdir(aDir), mkdir(bDir)]);
const clients = [];
async function connect() {
  const transport = url
    ? new StreamableHTTPClientTransport(url)
    : new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('start.mjs', import.meta.url))],
        env: process.env,
        stderr: 'pipe',
      });
  const client = new Client({ name: 'dwb-release-acceptance', version: '1' });
  clients.push(client);
  await client.connect(transport);
  return client;
}
const meta = (id) => ({ 'openai/session': `v1/acceptance-${root}-${id}` });
const call = (client, chat, name, args = {}) =>
  client.callTool({ name, arguments: args, _meta: meta(chat) });
const status = async (client, chat) =>
  (await call(client, chat, 'dwb_session_status')).structuredContent;
let brokerPid;
try {
  const a = await connect(),
    b = await connect();
  brokerPid = (await call(a, 'a', 'dwb_broker_status')).structuredContent.brokerPid;
  const initialToolNames = (await b.listTools({ _meta: meta('b') })).tools
    .map((tool) => tool.name)
    .sort();
  await call(a, 'a', 'workspace', {
    action: 'bind',
    path: aDir,
    name: `ร้านทดสอบ ${basename(root)}`,
    aliases: [alias],
  });
  await call(b, 'b', 'workspace', { action: 'bind', path: bDir });
  await call(a, 'a', 'write_file', {
    path: resolve(aDir, 'a.txt'),
    content: 'chat A',
    mode: 'rewrite',
  });
  await call(b, 'b', 'write_file', {
    path: resolve(bDir, 'b.txt'),
    content: 'chat B',
    mode: 'rewrite',
  });
  const beforeA = await status(a, 'a'),
    beforeB = await status(b, 'b');
  assert.equal(beforeA.workingDirectory, aDir);
  assert.equal(beforeB.workingDirectory, bDir);
  assert.notEqual(beforeA.sessionId, beforeB.sessionId);
  assert.notEqual(beforeA.workerPid, beforeB.workerPid);
  assert.equal(await readFile(resolve(aDir, 'a.txt'), 'utf8'), 'chat A');
  assert.equal(await readFile(resolve(bDir, 'b.txt'), 'utf8'), 'chat B');
  const c = await connect();
  if (url) {
    // A new chat can choose the registered name without a full directory.
    await call(c, 'c', 'workspace', { action: 'bind', workspace: alias });
    await call(c, 'c', 'read_file', { path: resolve(aDir, 'a.txt') });
    const afterC = await status(c, 'c');
    assert.equal(afterC.workingDirectory, aDir);
    assert.notEqual(afterC.sessionId, beforeA.sessionId);
    assert.notEqual(afterC.workerPid, beforeA.workerPid);
  } else {
    await a.close();
    let detached = false;
    for (let i = 0; i < 100; i++) {
      const list = (await call(b, 'b', 'dwb_list_detached_sessions')).structuredContent.sessions;
      if (list.some((s) => s.sessionId === beforeA.sessionId)) {
        detached = true;
        break;
      }
      await delay(25);
    }
    assert.ok(detached);
    await call(c, 'c', 'dwb_resume_session', { session_id: beforeA.sessionId });
    const resumed = await status(c, 'c');
    assert.equal(resumed.sessionId, beforeA.sessionId);
    assert.equal(resumed.workerPid, beforeA.workerPid);
    assert.equal(resumed.workingDirectory, aDir);
    process.kill(brokerPid);
    await delay(200);
    const [recovered, tools] = await Promise.all([
      status(c, 'c'),
      c.listTools({ _meta: meta('c') }),
    ]);
    brokerPid = (await call(c, 'c', 'dwb_broker_status')).structuredContent.brokerPid;
    assert.equal(recovered.sessionId, beforeA.sessionId);
    assert.equal(recovered.workingDirectory, aDir);
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), initialToolNames);
  }
  assert.equal((await status(b, 'b')).workingDirectory, bDir);
  console.log(
    JSON.stringify({
      result: 'RELEASE_ACCEPTANCE_PASS',
      transport: url ? 'local-tunnel-http' : 'stdio',
      node: process.version,
      worker: config.version,
      workspaceByName: !!url,
      crossChatIsolation: true,
      install: fileURLToPath(new URL('../', import.meta.url)),
    }),
  );
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  if (brokerPid) {
    try {
      process.kill(brokerPid);
    } catch {}
  }
}
