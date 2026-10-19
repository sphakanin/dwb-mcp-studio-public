import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  collectCompanionNotices,
  companionNoticesPath,
  embedCompanionNotices,
} from './companion-notices.mjs';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('dist/companion-panel.html', root), 'utf8');
const notices = (await readFile(new URL(companionNoticesPath, root), 'utf8')).replaceAll(
  '\r\n',
  '\n',
);
const embedded = html.match(
  /<template id="dwb-third-party-notices"><pre>([\s\S]*?)<\/pre><\/template>/,
);
assert.ok(embedded, 'Standalone HTML must retain its bundled licenses');
assert.equal(
  embedded[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'),
  notices,
);
for (const name of [
  '@modelcontextprotocol/client@',
  '@modelcontextprotocol/core@',
  '@modelcontextprotocol/ext-apps@',
  'zod@',
  'pkce-challenge@',
])
  assert.ok(notices.includes(name), 'Missing bundle attribution: ' + name);
assert.ok(notices.includes('Copyright (c) 2025 Colin McDonnell'));

const fixture = await mkdtemp(resolve(tmpdir(), 'dwb-notices-'));
try {
  const path = 'node_modules/outer/node_modules/@fixture/client';
  const directory = resolve(fixture, path);
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'package.json'),
    JSON.stringify({ name: '@fixture/client', version: '1.0.0', license: 'MIT' }),
  );
  const meta = {
    outputs: { 'bundle.js': { inputs: { [path + '/index.js']: { bytesInOutput: 1 } } } },
  };
  await assert.rejects(
    collectCompanionNotices(fixture, meta),
    /Missing bundled dependency license/,
  );
  await writeFile(resolve(directory, 'LICENSE'), '');
  await assert.rejects(collectCompanionNotices(fixture, meta), /Empty bundled dependency notice/);
  await writeFile(resolve(directory, 'LICENSE'), 'Fixture copyright and permission\n');
  await writeFile(resolve(directory, 'NOTICE.txt'), 'Required upstream attribution\n');
  const actual = await collectCompanionNotices(fixture, meta);
  assert.ok(actual.includes('@fixture/client@1.0.0'));
  assert.ok(actual.includes('Required upstream attribution'));
  const escaped = embedCompanionNotices(
    '<body></body>',
    '</pre></template><script>bad()</script> &',
  );
  assert.ok(!escaped.includes('<script>'));
} finally {
  await rm(fixture, { recursive: true, force: true });
}
console.log(
  'COMPANION_NOTICES_PASS: embedded text, transitive identity, nested packages, missing/empty licenses, NOTICE retention and HTML escaping',
);
