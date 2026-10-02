import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { cleanEnvironment, run } from '../posix-common.mjs';
import { assertOwned, verifyArchive } from '../posix-install.mjs';
import { linuxDataDir, readApiKey, tunnelProfile, validateTunnelId } from './common.mjs';
import { tunnelAssets } from './install.mjs';
import { renderService, serviceName, systemdQuote } from './service.mjs';

test('shared POSIX runner starts actual commands and terminates timed-out work', async () => {
  assert.equal(
    await run(process.execPath, ['-e', "process.stdout.write('runner-ok')"]),
    'runner-ok',
  );
  await assert.rejects(
    run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }),
    /timed out/,
  );
});

test('Linux configuration and tunnel credentials stay separate', () => {
  const data = resolve(tmpdir(), 'DWB data % path');
  assert.equal(linuxDataDir({ XDG_DATA_HOME: data }), resolve(data, 'DWB-MCP-Studio'));
  assert.equal(linuxDataDir({ DWB_DATA_DIR: data }), data);
  const env = cleanEnvironment({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'secret',
    DWB_TUNNEL_RUNTIME_KEY: 'secret',
    CONTROL_PLANE_API_KEY: 'secret',
    ALLOW_REMOTE_UI: 'true',
  });
  assert.deepEqual(env, { PATH: '/usr/bin' });
  const profile = tunnelProfile({ root: data, data, tunnelId: 'tunnel_test' });
  assert.equal(profile.control_plane.api_key, 'env:DWB_TUNNEL_RUNTIME_KEY');
  assert.equal(profile.health.listen_addr, '127.0.0.1:0');
  assert.equal(profile.admin_ui.open_browser, false);
  assert.throws(() => validateTunnelId('bad\nvalue'));
});
test('systemd keeps each data directory separate and quotes literal paths', () => {
  assert.notEqual(serviceName('/one'), serviceName('/two'));
  assert.equal(systemdQuote('/a %n/$PATH', true), '"/a %%n/$$PATH"');
  assert.equal(systemdQuote('DWB_DATA_DIR=/a %n/$PATH'), '"DWB_DATA_DIR=/a %%n/$PATH"');
  assert.throws(() => systemdQuote('/tmp/a\nExecStart=evil'));
  const unit = renderService({
    root: resolve(tmpdir(), 'with spaces'),
    data: resolve(tmpdir(), 'data'),
  });
  assert.match(unit, /KillMode=control-group/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /UMask=0077/);
  assert.doesNotMatch(unit, /api-key|DWB_TUNNEL_RUNTIME_KEY|PrivateTmp|WorkingDirectory/);
});
test('only a private, owned regular key file may supply credentials', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'dwb-linux-key-'));
  const path = resolve(dir, 'api-key');
  await writeFile(path, 'unit-test-key\n', { mode: 0o600 });
  assert.equal(await readApiKey(path), 'unit-test-key');
  await assert.rejects(readApiKey(dir));
  await assert.rejects(readApiKey(undefined), /absolute/);
  await writeFile(path, 'first\nsecond');
  await assert.rejects(readApiKey(path), /single-line/);
  await writeFile(path, 'x'.repeat(8194));
  await assert.rejects(readApiKey(path), /small regular/);
  if (process.platform !== 'win32') {
    await writeFile(path, 'unit-test-key');
    await chmod(path, 0o644);
    await assert.rejects(readApiKey(path), /mode 600/);
    await chmod(path, 0o600);
    await symlink(path, resolve(dir, 'alias'));
    await assert.rejects(readApiKey(resolve(dir, 'alias')));
  }
});
test('download verification rejects tampering and installations cannot escape external', async () => {
  const bytes = Buffer.from('verified archive');
  verifyArchive(bytes, createHash('sha256').update(bytes).digest('hex'));
  assert.throws(() => verifyArchive(Buffer.from('tampered'), tunnelAssets.x64.sha256), /checksum/);
  assert.deepEqual(Object.keys(tunnelAssets).sort(), ['arm64', 'x64']);
  const dir = await mkdtemp(resolve(tmpdir(), 'dwb-linux-install-'));
  const external = resolve(dir, 'external');
  await mkdir(external);
  await assert.rejects(assertOwned(external, resolve(dir, 'outside')), /escaped/);
  if (process.platform !== 'win32') {
    await symlink(dir, resolve(external, 'alias'), 'dir');
    await assert.rejects(assertOwned(external, resolve(external, 'alias/child')), /symbolic/);
  }
});
