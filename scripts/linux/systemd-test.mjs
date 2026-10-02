// Uses an isolated, uniquely named user unit. No hosted tunnel or real credential is used.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { cleanEnvironment, run, saveJson, saveText } from '../posix-common.mjs';
import { renderService, serviceName, servicePath } from './service.mjs';

if (process.platform !== 'linux' || !process.env.DWB_DATA_DIR)
  throw new Error('Run this on Ubuntu after Setup with an isolated DWB_DATA_DIR.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const original = JSON.parse(
  await readFile(resolve(process.env.DWB_DATA_DIR, 'config.json'), 'utf8'),
);
const scratch = await mkdtemp(resolve(tmpdir(), 'dwb-systemd-'));
const data = resolve(scratch, 'data with spaces %literal $literal');
const fixture = resolve(scratch, 'source with spaces %literal $literal');
const env = { ...cleanEnvironment(), DWB_DATA_DIR: data };
const cli = (...args) =>
  run(process.execPath, [resolve(root, 'scripts/linux/cli.mjs'), ...args], { env, timeout: 45000 });
const name = serviceName(data);
const unit = servicePath(data);
await assert.rejects(access(unit), { code: 'ENOENT' });
await run('systemctl', ['--user', 'show-environment'], { env });
await saveJson(resolve(data, 'config.json'), original);
const keyFile = resolve(data, 'test-key');
await saveText(keyFile, 'unit-test-key');
await mkdir(resolve(fixture, 'scripts/linux'), { recursive: true });
await writeFile(
  resolve(fixture, 'scripts/linux/cli.mjs'),
  `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { detached: true, stdio: 'ignore' });
writeFileSync(process.env.DWB_DATA_DIR + '/service-pids.json', JSON.stringify({ parent: process.pid, child: child.pid, entry: fileURLToPath(import.meta.url), data: process.env.DWB_DATA_DIR }));
setInterval(()=>{},1000);
`,
);
let installed = false;
let pids;
try {
  await cli('tunnel-config', '--tunnel-id', 'tunnel_unit_test', '--key-file', keyFile);
  await cli('service', 'install');
  installed = true;
  // Exercise generated systemd quoting and cgroup ownership without contacting OpenAI.
  await saveText(
    unit,
    renderService({ root: fixture, data }).replace('TimeoutStopSec=30', 'TimeoutStopSec=2'),
  );
  await run('systemctl', ['--user', 'daemon-reload'], { env });
  await cli('service', 'start');
  for (let i = 0; i < 80; i++) {
    pids = await readFile(resolve(data, 'service-pids.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    if (pids) break;
    await delay(100);
  }
  assert.ok(pids, 'User service did not start');
  assert.equal(
    pids.entry,
    resolve(fixture, 'scripts/linux/cli.mjs'),
    'systemd must preserve literal spaces, percent and dollar in paths',
  );
  assert.equal(pids.data, data, 'systemd must preserve literal data paths in Environment');
  assert.match(await cli('service', 'status'), /ActiveState=active/);
  await cli('service', 'stop');
  for (const pid of [pids.parent, pids.child]) {
    const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    assert.ok(!status || /\) Z /.test(status), 'systemd must terminate detached descendants');
  }
  const stopped = await cli('service', 'status');
  assert.match(stopped, /MainPID=0/);
  // This fixture deliberately ignores SIGTERM, so systemd records its forced
  // cleanup as a timeout rather than a normal inactive service.
  assert.match(stopped, /ActiveState=failed/);
  assert.match(stopped, /Result=timeout/);
  assert.deepEqual(JSON.parse(await readFile(resolve(data, 'config.json'), 'utf8')), original);
  console.log(
    'UBUNTU_SYSTEMD_PASS: install/start/status/stop, literal paths, forced detached descendant cleanup, retained config',
  );
} finally {
  if (installed) await cli('service', 'uninstall');
}
await assert.rejects(access(unit), { code: 'ENOENT' });
