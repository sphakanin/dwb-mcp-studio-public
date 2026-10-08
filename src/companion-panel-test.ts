import assert from 'node:assert/strict';
import {
  COMPANION_URI,
  COMPANION_MIME,
  companionTools,
  makeCompanionSnapshot,
} from './companion-panel.js';

assert.equal(companionTools[0].name, 'dwb_companion');
assert.equal(companionTools[0]._meta.ui.resourceUri, COMPANION_URI);
assert.deepEqual(companionTools[0]._meta['openai/ui']?.entrypoints, [{ type: 'thread' }]);
assert.equal(COMPANION_MIME, 'text/html;profile=mcp-app');
assert.equal(companionTools[1].name, 'dwb_companion_action');
assert.deepEqual(companionTools[1]._meta.ui.visibility, ['app']);
assert.equal(companionTools[2].name, 'dwb_companion_snapshot');
assert.deepEqual(companionTools[2]._meta.ui.visibility, ['app']);

const sample = makeCompanionSnapshot({
  broker: {
    runtime: { version: '0.1.0-beta.15' },
    workerCap: 4,
    activeWorkers: 2,
    queueDepth: 1,
    sessions: 3,
    inFlightCalls: 2,
    persistence: { healthy: true },
  },
  current: { id: 'ws_one', name: 'demo', root: 'C:/secret/directory' },
  workspaces: [
    { id: 'ws_one', name: 'demo', root: 'C:/secret/directory', aliases: ['demo'] },
    { id: 'ws_two', name: 'project-two', root: 'D:/private' },
  ],
  sessions: [
    {
      sessionId: 'private-session-id',
      workspaceName: 'demo',
      state: 'attached',
      workerPid: 1234,
      workerStatus: { ready: true },
      inFlight: 2,
    },
  ],
  skills: [{ id: 'grilling', name: 'Grilling', policy: 'ask' }],
});
assert.equal(sample.kind, 'dwb-companion-v1');
assert.equal(sample.currentWorkspace?.id, 'ws_one');
assert.deepEqual(sample.broker, {
  workerCap: 4,
  activeWorkers: 2,
  queueDepth: 1,
  sessions: 3,
  inFlightCalls: 2,
  persistenceHealthy: true,
});
assert.equal(sample.workspaces.length, 2);
assert.equal(sample.skills[0].policy, 'ask');
assert.equal(sample.sessions[0].ready, true);
const serialized = JSON.stringify(sample);
for (const privateValue of ['C:/secret/directory', 'D:/private', 'private-session-id']) {
  assert.ok(!serialized.includes(privateValue), 'Panel snapshot exposed local/private metadata');
}
assert.ok(!sample.workspaces[0].hasOwnProperty('root'));
console.log('COMPANION_PANEL_TEST_PASS: metadata, status, workspace selection, redaction');
