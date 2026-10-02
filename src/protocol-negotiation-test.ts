import { Client as ModernClient } from '@modelcontextprotocol/client';
import { StdioClientTransport as ModernStdio } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyStdio } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeTestBaseConfig } from './test-policy.js';

const projectRoot = process.cwd();
const entry = resolve(projectRoot, 'dist', 'index.js');
mkdirSync(resolve(projectRoot, 'logs'), { recursive: true });
const testDir = mkdtempSync(join(projectRoot, 'logs', 'protocol-'));
const baseConfig = await writeTestBaseConfig(testDir);
const pipe =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\dwb-protocol-${process.pid}-${Date.now()}`
    : resolve(testDir, 'broker.sock');
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);
const env = {
  ...inheritedEnv,
  DWB_BROKER_PIPE: pipe,
  DWB_WORKER_CAP: '1',
  DWB_BROKER_AUTOSTART: 'true',
  DWB_BROKER_ALLOW_SHUTDOWN: 'true',
  DWB_EVENT_LOG_PATH: resolve(testDir, 'events.jsonl'),
  DWB_WORKSPACE_DB: resolve(testDir, 'telemetry.db'),
  DWB_RUNTIME_DIR: resolve(testDir, 'runtime'),
  DWB_BASE_DC_CONFIG: baseConfig,
  DWB_PAYLOAD_ARCHIVE_DIR: resolve(testDir, 'payloads'),
};
let brokerPid: number | null = null;

function verifyToolSurface(tools: { name: string }[]): string[] {
  const names = new Set(tools.map((tool) => tool.name));
  const required = [
    'workspace',
    'skills',
    'dwb_bridge_status',
    'dwb_broker_status',
    'dwb_session_status',
    'dwb_restart_worker',
    'dwb_list_sessions',
    'dwb_list_detached_sessions',
    'dwb_resume_session',
    'get_config',
    'read_file',
    'write_file',
    'start_process',
  ];
  assert.equal(names.size, tools.length, 'Tool names must be unique');
  assert.ok(
    required.every((name) => names.has(name)),
    'Core and upstream tool surface must be present',
  );
  return [...names].sort();
}

async function modern() {
  const transport = new ModernStdio({
    command: process.execPath,
    args: [entry],
    cwd: testDir,
    env,
    stderr: 'pipe',
  });
  const client = new ModernClient(
    { name: 'dwb-modern-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(transport);
  try {
    const status: any = await client.callTool({ name: 'dwb_broker_status', arguments: {} });
    brokerPid = Number(status.structuredContent?.brokerPid ?? 0) || null;
    const tools = await client.listTools();
    const resources = await client.listResources();
    const preview = await client.readResource({ uri: 'ui://desktop-commander/file-preview' });
    if (client.getProtocolEra() !== 'modern')
      throw new Error(`Expected modern era, got ${client.getProtocolEra()}`);
    if (client.getNegotiatedProtocolVersion() !== '2026-07-28')
      throw new Error(`Unexpected modern version: ${client.getNegotiatedProtocolVersion()}`);
    const toolNames = verifyToolSurface(tools.tools);
    if (
      resources.resources.length !== 2 ||
      !String(preview.contents?.[0]?.mimeType).includes('mcp-app')
    )
      throw new Error('Modern resource proxy mismatch');
    return {
      era: client.getProtocolEra(),
      version: client.getNegotiatedProtocolVersion(),
      tools: tools.tools.length,
      toolNames,
      resources: resources.resources.length,
    };
  } finally {
    await client.close();
  }
}

async function legacy() {
  const transport = new LegacyStdio({
    command: process.execPath,
    args: [entry],
    cwd: testDir,
    env,
    stderr: 'pipe',
  });
  const client = new LegacyClient({ name: 'dwb-legacy-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const resources = await client.listResources();
    const toolNames = verifyToolSurface(tools.tools);
    if (resources.resources.length !== 2) throw new Error('Legacy resource proxy mismatch');
    const status: any = await client.callTool({ name: 'dwb_broker_status', arguments: {} });
    brokerPid = Number(status.structuredContent?.brokerPid ?? 0) || null;
    return {
      server: client.getServerVersion(),
      tools: tools.tools.length,
      toolNames,
      resources: resources.resources.length,
    };
  } finally {
    await client.close();
  }
}

try {
  const modernResult = await modern();
  const legacyResult = await legacy();
  assert.deepEqual(
    modernResult.toolNames,
    legacyResult.toolNames,
    'Both protocols must expose the same complete tool surface',
  );
  console.log(
    'PROTOCOL_NEGOTIATION_PASS',
    JSON.stringify({ modern: modernResult, legacy: legacyResult }),
  );
} finally {
  if (brokerPid) {
    try {
      process.kill(brokerPid);
    } catch {}
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  // Keep logs for diagnosis. Removing a directory while a worker is exiting on
  // Windows can mask the actual test failure with an EPERM cleanup error.
}
import assert from 'node:assert/strict';
