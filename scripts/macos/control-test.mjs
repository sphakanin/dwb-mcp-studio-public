import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createControlServer } from './server.mjs';
import { assertOwned, tunnelAssets, verifyArchive } from './install.mjs';
import {
  cleanEnvironment,
  commitJsonFiles,
  json,
  preferences,
  saveJson,
  shellQuote,
  xml,
} from './common.mjs';

const token = 'unit-test-token';
const calls = [];
const fake = {
  status: async () => ({
    tunnel: 'stopped',
    runtime: { state: 'stopped' },
    preferences: preferences(),
  }),
  setup: async (body) => {
    calls.push(['setup', body]);
    return { ok: true };
  },
  start: async (body) => {
    calls.push(['start', body]);
    return { ok: true };
  },
  stop: async () => {
    calls.push(['stop']);
    return { ok: true };
  },
  exclusive: (action) => action(),
  forgetKey: async () => ({ ok: true }),
  savePreferences: async (input) => {
    preferences(input);
    return { ok: true };
  },
};
const server = createControlServer(fake, token);
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const request = (path, body, headers = {}) =>
  fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
try {
  assert.equal((await fetch(origin + '/api/status')).status, 401);
  assert.equal((await request('/api/start', {}, { Origin: 'https://evil.example' })).status, 403);
  const badHost = await new Promise((done, reject) => {
    const req = httpRequest(
      origin + '/api/status',
      { headers: { Host: 'evil.example', Authorization: `Bearer ${token}` } },
      (res) => {
        res.resume();
        done(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await request('/api/start', {}, { 'Content-Type': 'text/plain' })).status, 405);
  assert.equal(calls.length, 0);
  assert.equal((await request('/api/status')).status, 200);
  assert.equal(
    (await request('/api/setup', { workspace: '/tmp/workspace', workerCap: 2 })).status,
    200,
  );
  assert.equal(calls.length, 1);
  assert.equal((await request('/api/start', { apiKey: 'x'.repeat(33000) })).status, 413);
  assert.equal(calls.length, 1);
  assert.equal((await request('/api/preferences', { startAtLogin: 'yes' })).status, 400);
  assert.equal((await request('/api/missing', {})).status, 404);
  assert.equal((await request('/api/start', [])).status, 400);
  const page = await fetch(origin);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.ok(!(await page.text()).includes(token));
  assert.equal((await fetch(origin + '/../../package.json')).status, 401);
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
const dir = await mkdtemp(resolve(tmpdir(), 'dwb-control-test-'));
await saveJson(resolve(dir, 'state.json'), { workspace: 'path with spaces' });
assert.deepEqual(await json(resolve(dir, 'state.json')), { workspace: 'path with spaces' });
await assert.rejects(
  commitJsonFiles(
    [
      [resolve(dir, 'state.json'), { changed: true }],
      [resolve(dir, 'second.json'), {}],
    ],
    async (path, value) => {
      if (path.endsWith('second.json')) throw new Error('injected disk error');
      await saveJson(path, value);
    },
  ),
  /injected disk error/,
);
assert.deepEqual(
  await json(resolve(dir, 'state.json')),
  { workspace: 'path with spaces' },
  'Failed multi-file save must restore the previous config',
);
await assertOwned(dir, resolve(dir, 'child'));
await assert.rejects(assertOwned(dir, resolve(dir, '../outside')), /escaped/);
await mkdir(resolve(dir, 'outside'));
await symlink(
  resolve(dir, 'outside'),
  resolve(dir, 'link'),
  process.platform === 'win32' ? 'junction' : 'dir',
);
await assert.rejects(assertOwned(dir, resolve(dir, 'link/file')), /symbolic/);
const bytes = Buffer.from('fixture');
verifyArchive(bytes, createHash('sha256').update(bytes).digest('hex'));
assert.throws(() => verifyArchive(bytes, '0'.repeat(64)), /checksum/);
assert.equal(Object.keys(tunnelAssets).length, 2);
assert.deepEqual(
  cleanEnvironment({
    PATH: 'safe',
    DWB_WORKER_ENTRY: 'bad',
    DWB_TUNNEL_RUNTIME_KEY: 'secret',
    OPENAI_API_KEY: 'secret',
    MCP_COMMAND: 'bad',
  }),
  { PATH: 'safe' },
);
assert.equal(shellQuote("a'b $HOME"), "'a'\\''b $HOME'");
assert.throws(() => shellQuote('bad\npath'));
assert.equal(xml('a<&"'), 'a&lt;&amp;&quot;');
console.log(
  'MAC_CONTROL_PASS: HTTP auth/origin/body limits, settings, environment isolation, path ownership, checksum, quoting.',
);
