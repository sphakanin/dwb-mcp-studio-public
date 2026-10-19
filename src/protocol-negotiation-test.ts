import { Client as ModernClient } from '@modelcontextprotocol/client';
import { StdioClientTransport as ModernStdio } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyStdio } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeTestBaseConfig } from './test-policy.js';

const projectRoot = process.cwd();
const entry = resolve(projectRoot, 'dist', 'index.js');
mkdirSync(resolve(projectRoot, 'logs'), { recursive: true });
const testDir = mkdtempSync(join(projectRoot, 'logs', 'protocol-'));
const baseConfig = await writeTestBaseConfig(testDir);
// The manager test requires a nonempty policy, unlike the isolated worker smoke fixtures.
const testPolicy = JSON.parse(readFileSync(baseConfig, 'utf8'));
testPolicy.allowedDirectories = [testDir];
writeFileSync(baseConfig, JSON.stringify(testPolicy));
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
    'dwb_companion',
    'dwb_companion_snapshot',
    'dwb_companion_action',
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
    // Test privileged base-policy review/apply only on the isolated fixture before workers start.
    const newRoot = resolve(testDir, 'extra-allowed');
    mkdirSync(newRoot);
    const policyReview: any = await client.callTool({
      name: 'dwb_companion_action',
      arguments: { action: 'review_root', operation: 'root_add', path: newRoot },
    });
    const policyToken = policyReview.structuredContent?.review?.token;
    assert.ok(policyToken, 'Root changes require a review token');
    const appliedPolicy: any = await client.callTool({
      name: 'dwb_companion_action',
      arguments: { action: 'apply_review', review_token: policyToken },
    });
    assert.match(appliedPolicy.structuredContent?.message ?? '', /Restart DWB MCP/);
    assert.equal(JSON.parse(readFileSync(baseConfig, 'utf8')).allowedDirectories.length, 2);
    const tools = await client.listTools();
    const resources = await client.listResources();
    const preview = await client.readResource({ uri: 'ui://desktop-commander/file-preview' });
    const companion = await client.readResource({ uri: 'ui://dwb-mcp-studio/companion-panel' });
    const entry = tools.tools.find((item: any) => item.name === 'dwb_companion') as any;
    assert.equal(entry?._meta?.ui?.resourceUri, 'ui://dwb-mcp-studio/companion-panel');
    assert.deepEqual(entry?._meta?.['openai/ui']?.entrypoints, [{ type: 'thread' }]);
    assert.equal(entry?._meta?.['openai/outputTemplate'], 'ui://dwb-mcp-studio/companion-panel');
    assert.ok(companion.contents?.[0] && 'text' in companion.contents[0]);
    assert.ok(
      'text' in companion.contents[0] && companion.contents[0].text.includes('DWB Companion'),
    );
    assert.equal(companion.contents?.[0]?.mimeType, 'text/html;profile=mcp-app');
    // Round-trip app-only registry actions against an isolated local broker and SQLite DB.
    const sampleDir = resolve(testDir, 'manager-sample');
    mkdirSync(sampleDir);
    const registered: any = await client.callTool({
      name: 'workspace',
      arguments: { action: 'register', path: sampleDir },
    });
    const workspaceId = registered.structuredContent?.workspace?.id;
    assert.ok(workspaceId, 'Workspace registration returned an ID');
    const launch: any = await client.callTool({ name: 'dwb_companion', arguments: {} });
    assert.ok(
      !JSON.stringify(launch.structuredContent).includes(sampleDir),
      'Model-visible launch must redact local absolute paths.',
    );
    const snapshot: any = await client.callTool({
      name: 'dwb_companion_snapshot',
      arguments: {},
    });
    assert.ok(
      snapshot.structuredContent?.workspaces?.some(
        (w: any) => w.id === workspaceId && w.path === sampleDir && w.status === 'ready',
      ),
      'App-only snapshot must include registered project location.',
    );
    const hideReview: any = await client.callTool({
      name: 'dwb_companion_action',
      arguments: { action: 'review_workspace', operation: 'hide', workspace_id: workspaceId },
    });
    const hideToken = hideReview.structuredContent?.review?.token;
    assert.ok(hideToken, 'Hide must require a review token');
    const hidden: any = await client.callTool({
      name: 'dwb_companion_action',
      arguments: { action: 'apply_review', review_token: hideToken },
    });
    assert.ok(
      hidden.structuredContent?.workspaces?.some((w: any) => w.id === workspaceId && w.hidden),
    );
    const hiddenLaunch: any = await client.callTool({ name: 'dwb_companion', arguments: {} });
    assert.ok(
      !hiddenLaunch.structuredContent?.workspaces?.some((w: any) => w.id === workspaceId),
      'Hidden workspace must be absent from normal model-visible picker',
    );
    const unhideReview: any = await client.callTool({
      name: 'dwb_companion_action',
      arguments: { action: 'review_workspace', operation: 'unhide', workspace_id: workspaceId },
    });
    const unhideToken = unhideReview.structuredContent?.review?.token;
    assert.ok(unhideToken);
    const unhidden: any = await client.callTool({
      name: 'dwb_companion_action',
      arguments: { action: 'apply_review', review_token: unhideToken },
    });
    assert.ok(
      unhidden.structuredContent?.workspaces?.some((w: any) => w.id === workspaceId && !w.hidden),
    );
    const reviewed: any = await client.callTool({
      name: 'dwb_companion_action',
      arguments: { action: 'review_workspace', operation: 'archive', workspace_id: workspaceId },
    });
    const token = reviewed.structuredContent?.review?.token;
    assert.ok(token, 'Archive must require a review token');
    const archived: any = await client.callTool({
      name: 'dwb_companion_action',
      arguments: { action: 'apply_review', review_token: token },
    });
    assert.ok(
      archived.structuredContent?.workspaces?.some(
        (w: any) => w.id === workspaceId && w.status === 'archived',
      ),
    );
    await assert.rejects(
      client.callTool({
        name: 'dwb_companion_action',
        arguments: { action: 'apply_review', review_token: token },
      }),
      /Review expired or does not match/,
      'Review token cannot be replayed',
    );
    if (client.getProtocolEra() !== 'modern')
      throw new Error(`Expected modern era, got ${client.getProtocolEra()}`);
    if (client.getNegotiatedProtocolVersion() !== '2026-07-28')
      throw new Error(`Unexpected modern version: ${client.getNegotiatedProtocolVersion()}`);
    const toolNames = verifyToolSurface(tools.tools);
    if (
      resources.resources.length !== 3 ||
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
    if (resources.resources.length !== 3) throw new Error('Legacy resource proxy mismatch');
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
