import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './common.mjs';

if (process.platform !== 'darwin') throw new Error('Native tests require a Mac.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const helper = resolve(root, 'DWB MCP Studio.app/Contents/MacOS/DWBStudio');
const service = `com.dwb.mcp-studio.test.${randomUUID()}`;
const secret = 'test-only-' + randomUUID();
async function keychain(operation, value = '') {
  return JSON.parse(
    await run(helper, ['--keychain'], {
      input: JSON.stringify({ operation, service, account: 'test', secret: value }),
      timeout: 60000,
    }),
  );
}
try {
  await keychain('set', secret);
  assert.equal((await keychain('get')).secret, secret);
  await keychain('set', secret + '-updated');
  assert.equal((await keychain('get')).secret, secret + '-updated');
  await keychain('delete');
  assert.equal((await keychain('get')).secret, '');
  console.log('MAC_KEYCHAIN_PASS');
} finally {
  await keychain('delete');
}
