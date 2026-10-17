import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(resolve(root, 'logs'), { recursive: true });
const testDir = await mkdtemp(resolve(root, 'logs', 'public-core-'));
const relocated = resolve(testDir, 'relocated core with spaces');
for (const name of ['dist', 'scripts'])
  await cp(resolve(root, name), resolve(relocated, name), { recursive: true });
await cp(resolve(root, 'package.json'), resolve(relocated, 'package.json'));
const fixture = resolve(testDir, 'user installed worker', 'dist');
await mkdir(fixture, { recursive: true });
// This fixture is our own test double, not Desktop Commander source.
await writeFile(
  resolve(fixture, '..', 'package.json'),
  JSON.stringify({ name: '@wonderwhy-er/desktop-commander', version: '0.2.50', type: 'module' }),
);
const original = "import os from 'node:os';\nexport const USER_HOME = os.homedir();\n";
await writeFile(resolve(fixture, 'config.js'), original);
await writeFile(
  resolve(fixture, 'index.js'),
  `
import os from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { USER_HOME } from './config.js';
const server = new Server({name:'dwb-test-double', version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:['get_config','read_file','write_file'].map(name=>({name,inputSchema:{type:'object',additionalProperties:true}}))}));
server.setRequestHandler(CallToolRequestSchema, async request => {
 const args=request.params.arguments || {};
 let value;
 if(request.params.name === 'get_config') value={configHome:USER_HOME,osHome:os.homedir(),pid:process.pid,cwd:process.cwd()};
 else if(request.params.name === 'list_sessions') value='No active sessions';
 else if(request.params.name === 'list_searches') value='No active searches';
 else if(request.params.name === 'read_file') value=await readFile(args.path,'utf8');
 else if(request.params.name === 'write_file') { if(args.delay) await new Promise(r=>setTimeout(r,args.delay)); await writeFile(args.path,args.content); value='written'; }
 else value=[];
 return {content:[{type:'text',text:JSON.stringify(value)}]};
});
await server.connect(new StdioServerTransport());
`,
);
const env = {
  ...process.env,
  DWB_DATA_DIR: resolve(testDir, 'user data'),
  DWB_CONFIG_FILE: resolve(testDir, 'user data', 'config.json'),
  DWB_BROKER_ALLOW_SHUTDOWN: 'true',
  DWB_RUNTIME_DIR: resolve(testDir, 'runtime'),
  DWB_BROKER_STATE_PATH: resolve(testDir, 'runtime', 'broker-state.json'),
  DWB_WORKSPACE_DB: resolve(testDir, 'runtime', 'workspaces.db'),
  DWB_EVENT_LOG_PATH: resolve(testDir, 'events.jsonl'),
};
for (const key of [
  'DWB_WORKER_ENTRY',
  'DWB_WORKER_CAP',
  'DWB_WORKSPACE',
  'DWB_BASE_DC_CONFIG',
  'DWB_BROKER_PIPE',
])
  delete env[key];
function run(script, args = [], expected = 0) {
  const result = spawnSync(process.execPath, [resolve(relocated, 'scripts', script), ...args], {
    env,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  assert.equal(result.status, expected, result.stderr || result.error?.message);
  return result;
}
assert.match(run('doctor.mjs', [], 1).stderr, /DWB_WORKER_ENTRY/);
run('configure.mjs', [
  '--worker-entry',
  resolve(fixture, 'index.js'),
  '--workspace',
  testDir,
  '--worker-cap',
  '2',
]);
const report = JSON.parse(run('doctor.mjs').stdout);
assert.equal(report.ok, true);
assert.equal(report.workerCap, 2);
assert.equal(report.runtime.state, 'stopped');
assert.equal(JSON.parse(run('dashboard-probe.mjs').stdout).state, 'stopped');
assert.ok(report.brokerEndpoint.includes('dwb-mcp-studio-core'));
const policyPath = resolve(testDir, 'user data', 'base-policy.json');
const customPolicy = { allowedDirectories: [testDir], fileReadLineLimit: 123 };
await writeFile(policyPath, JSON.stringify(customPolicy));
run('configure.mjs', ['--worker-entry', resolve(fixture, 'index.js'), '--workspace', testDir]);
assert.deepEqual(
  JSON.parse(await readFile(policyPath)),
  customPolicy,
  'Configure must preserve a user-edited policy.',
);
const clientConfig = JSON.parse(await readFile(resolve(testDir, 'user data', 'mcp-client.json')))
  .mcpServers['dwb-core'];
assert.equal(clientConfig.args[0], resolve(relocated, 'scripts', 'start.mjs'));

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const clients = [];
let brokerPid;
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
try {
  for (let n = 0; n < 2; n++) {
    const transport = new StdioClientTransport({
      command: clientConfig.command,
      args: clientConfig.args,
      env,
      stderr: 'pipe',
    });
    const client = new Client({ name: `public-core-${n}`, version: '1' });
    clients.push({ client, transport });
    await client.connect(transport);
  }
  const [a, b] = clients.map((c) => c.client);
  brokerPid = (await call(a, 'dwb_broker_status')).structuredContent.brokerPid;
  const beforeDoctor = (await call(a, 'dwb_broker_status')).structuredContent;
  const liveReport = JSON.parse(run('doctor.mjs').stdout);
  assert.equal(liveReport.runtime.state, 'running');
  assert.equal(liveReport.runtime.brokerPid, brokerPid);
  assert.equal(
    liveReport.runtime.sessions,
    beforeDoctor.sessions,
    'Doctor must not attach a session',
  );
  assert.equal(
    liveReport.runtime.activeWorkers,
    beforeDoctor.activeWorkers,
    'Doctor must not spawn a worker',
  );
  const dashboard = JSON.parse(run('dashboard-probe.mjs').stdout);
  assert.equal(dashboard.state, 'running');
  assert.equal(dashboard.broker.sessions, beforeDoctor.sessions, 'Dashboard must not attach');
  assert.equal(
    dashboard.broker.activeWorkers,
    beforeDoctor.activeWorkers,
    'Dashboard must not allocate',
  );
  assert.equal(dashboard.sessions.length, beforeDoctor.sessions);
  assert.equal(dashboard.sessions[0].workingDirectory, testDir);
  const secondSnapshot = JSON.parse(run('dashboard-probe.mjs').stdout);
  assert.deepEqual(
    secondSnapshot.sessions.map((s) => s.lastActivityAt),
    dashboard.sessions.map((s) => s.lastActivityAt),
    'Dashboard polling must not keep idle workers alive',
  );
  const surface = (await a.listTools()).tools.map((t) => t.name);
  assert.deepEqual(
    surface.filter((n) => !['get_config', 'read_file', 'write_file'].includes(n)).sort(),
    [
      'dwb_bridge_status',
      'dwb_broker_status',
      'dwb_companion',
      'dwb_companion_snapshot',
      'dwb_companion_action',
      'dwb_session_status',
      'dwb_restart_worker',
      'dwb_list_sessions',
      'dwb_list_detached_sessions',
      'dwb_resume_session',
      'skills',
      'workspace',
    ].sort(),
  );
  const workerCountBeforePanel = (await call(a, 'dwb_broker_status')).structuredContent
    .activeWorkers;
  const companionPanel = await call(a, 'dwb_companion');
  assert.equal(companionPanel.structuredContent.kind, 'dwb-companion-v1');
  assert.equal(companionPanel.structuredContent.workspaces.length, 0);
  assert.ok(companionPanel.content[0].text.includes('dwb-companion-v1'));
  const refreshedCompanion = await call(a, 'dwb_companion_snapshot');
  assert.equal(refreshedCompanion.structuredContent.kind, 'dwb-companion-v1');
  assert.equal(
    (await call(a, 'dwb_broker_status')).structuredContent.activeWorkers,
    workerCountBeforePanel,
    'Companion snapshot must not allocate a Desktop Commander worker',
  );
  const projectHome = companionPanel.structuredContent.projectHomes[0];
  assert.ok(projectHome, 'At least one approved test project home must exist.');
  const createdViaPanel = await call(a, 'dwb_companion_action', {
    action: 'create',
    home_id: projectHome.id,
    project_name: 'panel-launch-site',
    project_kind: 'web',
  });
  assert.equal(createdViaPanel.structuredContent.currentWorkspace.name, 'panel-launch-site');
  assert.match(
    await readFile(resolve(testDir, 'panel-launch-site', 'README.md'), 'utf8'),
    /panel-launch-site/,
  );
  const panelCreatedId = createdViaPanel.structuredContent.currentWorkspace.id;
  assert.equal(createdViaPanel.structuredContent.selectionLocked, true);
  await assert.rejects(
    call(a, 'dwb_companion_action', {
      action: 'create',
      home_id: projectHome.id,
      project_name: 'blocked-after-lock',
      project_kind: 'blank',
    }),
    /DWB_WORKSPACE_LOCKED/,
  );
  await assert.rejects(readFile(resolve(testDir, 'blocked-after-lock', 'README.md')), {
    code: 'ENOENT',
  });
  const anotherProject = resolve(testDir, 'panel-reference');
  await mkdir(anotherProject);
  // After first selection, neither Add Existing nor Switch may redirect this chat.
  await assert.rejects(
    call(a, 'dwb_companion_action', { action: 'add_existing', path: anotherProject }),
    /DWB_WORKSPACE_LOCKED/,
  );
  const registered = await call(a, 'workspace', { action: 'register', path: anotherProject });
  const referenceId = registered.structuredContent.workspace.id;
  const withReference = await call(a, 'dwb_companion_action', {
    action: 'related_add',
    workspace_id: referenceId,
  });
  assert.equal(withReference.structuredContent.relatedWorkspaces[0].id, referenceId);
  assert.equal(withReference.structuredContent.currentWorkspace.name, 'panel-launch-site');
  const removedReference = await call(a, 'dwb_companion_action', {
    action: 'related_remove',
    workspace_id: referenceId,
  });
  assert.equal(removedReference.structuredContent.relatedWorkspaces.length, 0);
  await assert.rejects(
    call(a, 'dwb_companion_action', { action: 'switch', workspace_id: referenceId }),
    /DWB_WORKSPACE_LOCKED/,
  );
  const sameViaPanel = await call(a, 'dwb_companion_action', {
    action: 'switch',
    workspace_id: panelCreatedId,
  });
  assert.equal(sameViaPanel.structuredContent.currentWorkspace.name, 'panel-launch-site');

  // Presentation Mode: exercise real app-only and model-visible endpoints against
  // this harness's temporary SQLite/policy, never the live DWB registry.
  const policyBeforePresentation = await readFile(policyPath, 'utf8');
  const registryBeforePresentation = (
    await call(a, 'dwb_companion_snapshot')
  ).structuredContent.workspaces
    .map((w) => w.id)
    .sort();
  await assert.rejects(
    call(a, 'dwb_companion_action', { action: 'presentation_enter' }),
    /Choose at least one accessible Demo Workspace/,
  );
  await assert.rejects(
    call(a, 'dwb_companion_action', {
      action: 'presentation_configure',
      demo_workspace_ids: ['unknown-workspace'],
    }),
    /unknown registered workspace/,
  );
  const allowlisted = await call(a, 'dwb_companion_action', {
    action: 'presentation_configure',
    demo_workspace_ids: [referenceId],
  });
  assert.deepEqual(allowlisted.structuredContent.presentation, {
    enabled: false,
    demoWorkspaceIds: [referenceId],
  });
  const presentationEntered = await call(a, 'dwb_companion_action', {
    action: 'presentation_enter',
  });
  const present = presentationEntered.structuredContent;
  assert.equal(present.presentation.enabled, true);
  assert.equal(present.currentWorkspace, null, 'Hidden locked workspace must be masked');
  assert.equal(present.selectionLocked, true, 'Chat workspace lock must survive masking');
  assert.deepEqual(
    present.workspaces.map((w) => w.name),
    ['panel-reference'],
  );
  assert.deepEqual(present.relatedWorkspaces, []);
  assert.deepEqual(present.allowedDirectories, []);
  assert.deepEqual(present.sessions, [], 'Hidden sessions must not be present');
  assert.equal(present.broker.sessions, 0, 'Hidden session count must not leak');
  assert.equal(present.workspaces[0].path, '(path masked for recording)');
  assert.deepEqual(present.workspaces[0].usage, { bindings: 0, references: 0 });
  const outputDuringRecording = JSON.stringify(present);
  for (const secret of ['panel-launch-site', testDir, 'session_workspace_bindings']) {
    assert.equal(outputDuringRecording.includes(secret), false, 'Presentation path/name leak');
  }
  const otherChatAppSnapshot = (await call(b, 'dwb_companion_snapshot')).structuredContent;
  assert.equal(otherChatAppSnapshot.presentation.enabled, true, 'New chats share stored settings');
  assert.deepEqual(
    otherChatAppSnapshot.workspaces.map((w) => w.name),
    ['panel-reference'],
  );
  assert.equal(
    JSON.stringify(otherChatAppSnapshot).includes('panel-launch-site'),
    false,
    'Other chat app snapshot must not expose hidden projects',
  );
  const modelSnapshot = (await call(b, 'dwb_companion')).structuredContent;
  assert.equal(modelSnapshot.presentation.enabled, true);
  assert.deepEqual(
    modelSnapshot.workspaces.map((w) => w.name),
    ['panel-reference'],
  );
  assert.equal(JSON.stringify(modelSnapshot).includes(testDir), false);
  await assert.rejects(
    call(a, 'dwb_companion_action', {
      action: 'related_add',
      workspace_id: panelCreatedId,
    }),
    /not available in Presentation Mode/,
  );
  await assert.rejects(
    call(a, 'dwb_companion_action', { action: 'switch', workspace_id: referenceId }),
    /DWB_WORKSPACE_LOCKED/,
  );
  const afterExit = await call(b, 'dwb_companion_action', { action: 'presentation_exit' });
  assert.equal(afterExit.structuredContent.presentation.enabled, false);
  assert.deepEqual(
    afterExit.structuredContent.workspaces.map((w) => w.id).sort(),
    registryBeforePresentation,
    'Exit must restore all pre-existing workspaces',
  );
  const normalAfterPresentation = (await call(a, 'dwb_companion_snapshot')).structuredContent;
  assert.equal(normalAfterPresentation.currentWorkspace.id, panelCreatedId);
  assert.equal(normalAfterPresentation.selectionLocked, true);
  assert.equal(await readFile(policyPath, 'utf8'), policyBeforePresentation);
  assert.deepEqual(normalAfterPresentation.relatedWorkspaces, []);
  await assert.rejects(call(a, 'workspace', { action: 'unbind' }), /DWB_WORKSPACE_LOCKED/);
  await assert.rejects(
    call(b, 'dwb_companion_action', {
      action: 'add_existing',
      path: resolve(testDir, '..'),
    }),
    /outside DWB allowedDirectories/,
    'Panel must honor the base directory policy before selecting a project.',
  );
  assert.ok(
    (await call(a, 'dwb_broker_status')).structuredContent.activeWorkers <= workerCountBeforePanel,
    'Project actions may retire idle workers but must not allocate workers.',
  );

  const configA = JSON.parse((await call(a, 'get_config')).content[0].text);
  const configB = JSON.parse((await call(b, 'get_config')).content[0].text);
  assert.notEqual(configA.pid, configB.pid);
  const activeDashboard = JSON.parse(run('dashboard-probe.mjs').stdout);
  assert.equal(activeDashboard.broker.activeWorkers, 2);
  assert.deepEqual(
    activeDashboard.sessions.map((s) => s.workerPid).sort(),
    [configA.pid, configB.pid].sort(),
  );
  await writeFile(resolve(testDir, 'dashboard-snapshot.json'), JSON.stringify(activeDashboard));
  assert.notEqual(configA.configHome, configB.configHome);
  assert.equal(configA.osHome, homedir());
  assert.equal(configB.osHome, homedir());
  assert.equal(await readFile(resolve(fixture, 'config.js'), 'utf8'), original);
  const bound = resolve(testDir, 'panel-launch-site');
  const differentWorkspace = resolve(testDir, 'workspace');
  await mkdir(differentWorkspace);
  await assert.rejects(
    call(a, 'workspace', { action: 'bind', workspace: differentWorkspace }),
    /DWB_WORKSPACE_LOCKED/,
  );
  await call(a, 'workspace', { action: 'bind', workspace: bound });
  const reboundConfig = JSON.parse((await call(a, 'get_config')).content[0].text);
  assert.equal(reboundConfig.cwd, bound);

  const skillSource = resolve(bound, '.agents', 'skills', 'demo-skill');
  await mkdir(skillSource, { recursive: true });
  await writeFile(
    resolve(skillSource, 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: Demo integration skill.',
      '---',
      '',
      '# Demo',
      'Follow the demo procedure.',
    ].join('\n'),
  );
  await writeFile(resolve(skillSource, 'guide.md'), '# Companion\nRead only after activation.');
  const installedSkill = await call(a, 'skills', {
    action: 'install_local',
    path: skillSource,
    policy: 'ask',
  });
  assert.equal(installedSkill.structuredContent.installed.id, 'demo-skill');
  const catalog = await call(a, 'skills', { action: 'list' });
  assert.equal(catalog.structuredContent.skills[0].policy, 'ask');

  const skillPending = await call(a, 'skills', { action: 'activate', skill: 'demo-skill' });
  assert.equal(skillPending.structuredContent.status, 'approval_required');
  const approvalId = skillPending.structuredContent.approvalId;
  const approved = await call(a, 'skills', {
    action: 'activate',
    skill: 'demo-skill',
    approval_id: approvalId,
    user_confirmed: true,
  });
  assert.equal(approved.structuredContent.status, 'active');
  assert.match(approved.structuredContent.instructions, /Follow the demo procedure/);
  const companion = await call(a, 'skills', {
    action: 'read_file',
    skill: 'demo-skill',
    relative_path: 'guide.md',
  });
  assert.match(companion.structuredContent.content, /Read only after activation/);

  await call(a, 'skills', {
    action: 'set_workspace_policy',
    skill: 'demo-skill',
    policy: 'manual',
  });
  assert.equal(
    (await call(a, 'skills', { action: 'activate', skill: 'demo-skill' })).structuredContent.status,
    'manual_only',
  );
  assert.equal(
    (
      await call(a, 'skills', {
        action: 'activate',
        skill: 'demo-skill',
        explicit_user_request: true,
      })
    ).structuredContent.status,
    'active',
  );
  assert.equal(reboundConfig.pid, configA.pid, 'Same-workspace bind keeps the active worker');
  assert.equal(JSON.parse((await call(b, 'get_config')).content[0].text).pid, configB.pid);
  await call(a, 'write_file', { path: 'relative.txt', content: 'in the bound workspace' });
  assert.equal(await readFile(resolve(bound, 'relative.txt'), 'utf8'), 'in the bound workspace');
  const outside = await call(a, 'write_file', {
    path: resolve(testDir, 'outside.txt'),
    content: 'must not write',
  });
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /DWB_WORKSPACE_BOUNDARY/);
  const file = resolve(bound, 'shared.txt');
  await writeFile(file, 'one');
  await call(a, 'read_file', { path: file });
  await call(b, 'write_file', { path: file, content: 'two' });
  assert.equal((await call(a, 'write_file', { path: file, content: 'stale' })).isError, true);
  assert.equal(await readFile(file, 'utf8'), 'two');
  await call(a, 'read_file', { path: file });
  assert.notEqual(
    (await call(a, 'write_file', { path: file, content: 'reconciled' })).isError,
    true,
  );
  assert.equal(await readFile(file, 'utf8'), 'reconciled');
  const stateBefore = await readFile(env.DWB_BROKER_STATE_PATH, 'utf8');
  const duplicate = spawnSync(process.execPath, [resolve(relocated, 'dist', 'broker-server.js')], {
    env,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.equal(
    await readFile(env.DWB_BROKER_STATE_PATH, 'utf8'),
    stateBefore,
    'A losing broker startup must not rewrite the live broker state',
  );
  const replies = await new Promise((resolveReplies, reject) => {
    const socket = createConnection(report.brokerEndpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Duplicate hello timed out'));
    }, 5000);
    let buffer = '';
    const messages = [];
    socket.setEncoding('utf8');
    socket.on('connect', () =>
      socket.write(
        [1, 2]
          .map((id) =>
            JSON.stringify({
              id: String(id),
              method: 'hello',
              params: { cwd: testDir },
            }),
          )
          .join('\n') + '\n',
      ),
    );
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        messages.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
      if (messages.length === 2) {
        clearTimeout(timer);
        socket.destroy();
        resolveReplies(messages);
      }
    });
  });
  assert.equal(
    replies.filter((message) => message.ok).length,
    1,
    'One connection can attach only once',
  );
  // Exercise deadlines over the real broker wire, including its response contract.
  const socket = createConnection(report.brokerEndpoint);
  socket.setEncoding('utf8');
  await new Promise((done, reject) => {
    socket.once('connect', done);
    socket.once('error', reject);
  });
  let wireBuffer = '';
  let nextId = 0;
  const pending = new Map();
  const counts = new Map();
  socket.on('data', (chunk) => {
    wireBuffer += chunk;
    let end;
    while ((end = wireBuffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(wireBuffer.slice(0, end));
      wireBuffer = wireBuffer.slice(end + 1);
      counts.set(message.id, (counts.get(message.id) ?? 0) + 1);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const rpc = (method, params = {}, timeout = 5000) =>
    new Promise((done, reject) => {
      const id = 'wire-' + ++nextId;
      const timer = setTimeout(() => reject(new Error('Wire request timed out: ' + method)), 8000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        done(value);
      });
      socket.write(JSON.stringify({ id, method, params, deadline: Date.now() + timeout }) + '\n');
    });
  try {
    assert.equal((await rpc('hello', { cwd: testDir })).ok, true);
    const queuedPath = resolve(testDir, 'cancelled-before-dispatch.txt');
    const queued = await rpc(
      'call_tool',
      { name: 'write_file', arguments: { path: queuedPath, content: 'must not exist' } },
      40,
    );
    assert.equal(queued.error.code, 'DWB_REQUEST_CANCELLED');
    await assert.rejects(readFile(queuedPath), { code: 'ENOENT' });
    assert.equal((await rpc('inspect')).result.broker.queueDepth, 0);
    for (const entry of clients) await entry.client.close();
    await rpc('call_tool', { name: 'get_config' });
    const delayedPath = resolve(testDir, 'completed-after-deadline.txt');
    const dispatched = await rpc(
      'call_tool',
      {
        name: 'write_file',
        arguments: { path: delayedPath, content: 'completed once', delay: 250 },
      },
      75,
    );
    assert.equal(dispatched.error.code, 'DWB_OUTCOME_PENDING');
    const busy = await rpc('prepare_upgrade');
    assert.match(busy.error.message, /DWB_UPGRADE_BUSY/);
    await new Promise((done) => setTimeout(done, 350));
    assert.equal(await readFile(delayedPath, 'utf8'), 'completed once');
    assert.equal(
      counts.get(dispatched.id),
      1,
      'A deadline must not produce a second reply after completion',
    );
    assert.equal((await rpc('inspect')).result.broker.inFlightCalls, 0);
    const prepared = await rpc('prepare_upgrade');
    assert.equal(prepared.ok, true);
    assert.equal(prepared.result.shuttingDown, true);
  } finally {
    socket.destroy();
  }
  console.log(
    'PUBLIC_CORE_PASS: relocated launcher, generated config, missing dependency, read-only Doctor, core-only tools, 2 isolated workers, real OS home, unchanged external files, workspace boundary, stale-write protection, broker singleton, duplicate hello',
  );
} finally {
  if (brokerPid) {
    try {
      process.kill(brokerPid);
    } catch {}
  }
  for (const { client, transport } of clients) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
