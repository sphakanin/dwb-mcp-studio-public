import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeTestBaseConfig } from './test-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const bridgeEntry = resolve(root, 'dist', 'index.js');
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);
const testHome = resolve(root, 'logs', 'smoke');
mkdirSync(testHome, { recursive: true });
const baseConfig = await writeTestBaseConfig(testHome);
const testPipe =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\dwb-smoke-${process.pid}-${Date.now()}`
    : resolve(testHome, 'broker.sock');
const testEnv = {
  ...inheritedEnv,
  DWB_BROKER_PIPE: testPipe,
  DWB_WORKER_CAP: '1',
  DWB_BROKER_ALLOW_SHUTDOWN: 'true',
  DWB_TELEMETRY_ENABLED: 'false',
  DWB_EVENT_LOG_PATH: resolve(testHome, 'events.jsonl'),
  DWB_RUNTIME_DIR: resolve(testHome, 'runtime'),
  DWB_BASE_DC_CONFIG: baseConfig,
};

function statusFrom(result: Awaited<ReturnType<Client['callTool']>>) {
  return result.structuredContent as {
    ready: boolean;
    workerPid: number;
    restartCount: number;
    desktopCommanderVersion: string;
    broker: { brokerPid: number };
  };
}

function allowedDirectories(result: Awaited<ReturnType<Client['callTool']>>): string[] {
  const structured = result.structuredContent as any;
  return structured?.config?.allowedDirectories ?? [];
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgeEntry],
    cwd: root,
    env: testEnv,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(String(chunk)));
  const client = new Client({ name: 'dwb-bridge-smoke', version: '0.1.0' });
  await client.connect(transport);

  const firstTools = await client.listTools(undefined, { timeout: 10_000 });
  const names = new Set(firstTools.tools.map((tool) => tool.name));
  if (!names.has('get_config') || !names.has('dwb_bridge_status')) {
    throw new Error('Expected Desktop Commander and bridge tools were not exposed');
  }

  const firstStatus = statusFrom(
    await client.callTool({
      name: 'dwb_bridge_status',
      arguments: {},
    }),
  );
  console.log('FIRST_STATUS', JSON.stringify(firstStatus));

  const configBefore = await client.callTool({ name: 'get_config', arguments: {} });
  if (configBefore.isError) throw new Error('get_config failed before recovery test');

  const persistedDir = resolve(testHome, 'persisted-allowed');
  mkdirSync(persistedDir, { recursive: true });
  const setConfig = await client.callTool({
    name: 'set_config_value',
    arguments: { key: 'allowedDirectories', value: [root, persistedDir] },
  });
  if (setConfig.isError) throw new Error('set_config_value failed before recovery test');
  const liveConfig = await client.callTool({ name: 'get_config', arguments: {} });
  if (liveConfig.isError || !allowedDirectories(liveConfig).includes(persistedDir))
    throw new Error('set_config_value did not update the live worker config');

  console.log('KILL_WORKER', firstStatus.workerPid);
  process.kill(firstStatus.workerPid);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));

  const recoveredTools = await client.listTools(undefined, { timeout: 15_000 });
  if (!recoveredTools.tools.some((tool) => tool.name === 'get_config')) {
    throw new Error('Tools missing after worker recovery');
  }
  const secondStatus = statusFrom(
    await client.callTool({
      name: 'dwb_bridge_status',
      arguments: {},
    }),
  );
  console.log('SECOND_STATUS', JSON.stringify(secondStatus));

  if (secondStatus.workerPid === firstStatus.workerPid) {
    throw new Error('Worker PID did not change after forced termination');
  }
  if (secondStatus.restartCount <= firstStatus.restartCount) {
    throw new Error('Restart counter did not increase');
  }

  const configAfter = await client.callTool({ name: 'get_config', arguments: {} });
  if (configAfter.isError) throw new Error('get_config failed after recovery test');
  if (!allowedDirectories(configAfter).includes(persistedDir))
    throw new Error('set_config_value did not persist across worker recovery');

  console.log(
    'SMOKE_PASS',
    JSON.stringify({
      exposedTools: recoveredTools.tools.length,
      oldPid: firstStatus.workerPid,
      newPid: secondStatus.workerPid,
      restartCount: secondStatus.restartCount,
    }),
  );

  await client.close();
  await transport.close();
  try {
    process.kill(firstStatus.broker.brokerPid);
  } catch {}
}

main().catch((error) => {
  console.error('SMOKE_FAIL', error);
  process.exit(1);
});
