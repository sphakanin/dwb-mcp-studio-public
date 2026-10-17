import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COMPANION_URI,
  COMPANION_MIME,
  companionTools,
  makeCompanionSnapshot,
} from './companion-panel.js';

assert.equal(companionTools[0].name, 'dwb_companion');
assert.equal(companionTools[0]._meta.ui.resourceUri, COMPANION_URI);
assert.deepEqual(companionTools[0]._meta['openai/ui']?.entrypoints, [{ type: 'thread' }]);
assert.equal(companionTools[0]._meta['openai/outputTemplate'], COMPANION_URI);
assert.equal(COMPANION_MIME, 'text/html;profile=mcp-app');
// Regression: string replacement of bundled JS once duplicated the HTML document.
const generatedHtml = readFileSync(
  new URL('../dist/companion-panel.html', import.meta.url),
  'utf8',
);
assert.equal((generatedHtml.match(/<!doctype html>/gi) ?? []).length, 1);
assert.ok(!generatedHtml.includes('DWB_COMPANION_SCRIPT'));
assert.equal((generatedHtml.match(/id="boot-status"/g) ?? []).length, 1);
// Regression: Companion is project context, NOT a prompt-sending chat bot.
assert.ok(!generatedHtml.includes('Continue with ChatGPT'));
assert.ok(!generatedHtml.includes('id="ask"'));
assert.ok(!generatedHtml.includes('id="manual"'));
assert.ok(generatedHtml.includes('id="related-count"'));
assert.ok(generatedHtml.includes('id="admin-section"'));
assert.match(generatedHtml, /id="refresh"[\s\S]*?aria-label="Refresh workspace information"/);
assert.ok(generatedHtml.includes('class="refresh-label"'));
assert.ok(
  generatedHtml.includes('@media (max-width: 560px)'),
  'Icon-only Refresh at narrow widths',
);
assert.ok(generatedHtml.includes('id="system-status"'));
assert.ok(generatedHtml.indexOf('id="system-status"') < generatedHtml.indexOf('id="updated"'));
assert.ok(!generatedHtml.includes('<footer>'), 'Policy and refresh time belong in System Status');
assert.ok(
  generatedHtml.indexOf('id="related-section"') < generatedHtml.indexOf('id="admin-section"'),
  'Supporting workspaces should be visible before advanced administration.',
);
const clientSource = readFileSync(new URL('../web/companion.ts', import.meta.url), 'utf8');
assert.ok(!clientSource.includes('app.sendMessage('), 'Panel must not send prompt messages');
assert.ok(!generatedHtml.includes('__DWB_COMPANION_LOGO__'));
const embeddedLogo = generatedHtml.match(
  /<img[^>]*class="logo"[^>]*src="data:image\/png;base64,([^"]+)"/,
);
assert.ok(embeddedLogo, 'A real PNG brand logo must be embedded in the MCP App HTML');
assert.equal(
  Buffer.from(embeddedLogo[1], 'base64').subarray(0, 8).toString('hex'),
  '89504e470d0a1a0a',
);
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

const demo = makeCompanionSnapshot({
  broker: { runtime: { version: 'test' }, sessions: 2 },
  current: { id: 'hidden', name: 'internal-secret-workspace' },
  selectionLocked: true,
  presentation: { enabled: true, demoWorkspaceIds: ['demo'] },
  workspaces: [
    { id: 'hidden', name: 'internal-secret-workspace', aliases: ['confidential-alias'] },
    { id: 'demo', name: 'public-demo' },
  ],
  related: [
    { id: 'hidden', name: 'internal-secret-workspace' },
    { id: 'demo', name: 'public-demo' },
  ],
  projectHomes: [{ id: 'secret-home', name: 'Private Folder' }],
  sessions: [
    { workspaceId: 'hidden', workspaceName: 'internal-secret-workspace', state: 'attached' },
    { workspaceId: 'demo', workspaceName: 'public-demo', state: 'attached' },
  ],
  skills: [],
});
assert.equal(demo.currentWorkspace, null, 'An unlisted active workspace must be masked');
assert.equal(demo.selectionLocked, true, 'Masking must preserve the session lock');
assert.deepEqual(
  demo.workspaces.map((w) => w.name),
  ['public-demo'],
);
assert.deepEqual(
  demo.relatedWorkspaces.map((w) => w.name),
  ['public-demo'],
);
assert.deepEqual(
  demo.sessions.map((s) => s.workspaceName),
  ['public-demo'],
);
assert.deepEqual(demo.projectHomes, []);
assert.equal(JSON.stringify(demo).includes('internal-secret-workspace'), false);
assert.ok(generatedHtml.includes('id="presentation-banner"'));
assert.ok(generatedHtml.includes('id="presentation-exit"'));
assert.ok(generatedHtml.includes('id="demo-allowlist"'));
console.log('COMPANION_PANEL_TEST_PASS: metadata, status, workspace selection, redaction');
