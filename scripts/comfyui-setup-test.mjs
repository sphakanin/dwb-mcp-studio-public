// Offline acceptance test for DWB ComfyUI Setup skill.
// Isolated fixtures only; NEVER contacts GitHub or modifies a real ComfyUI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('COMFYUI_SETUP_TEST_SKIPPED (Windows PowerShell only)');
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const scripts = resolve(root, 'skills', 'comfyui-setup', 'scripts');
const fixtureDir = await mkdtemp(resolve(root, 'logs', 'comfyui-installer-test-'));
function child(command, args, timeoutMs = 30_000) {
  return new Promise((done, reject) => {
    const p = spawn(command, args, { cwd: fixtureDir, windowsHide: true, env: process.env });
    let out = '',
      err = '';
    let ended = false;
    const timer = setTimeout(() => {
      if (!ended) p.kill();
      reject(new Error('Test subprocess timed out'));
    }, timeoutMs);
    p.stdout.on('data', (buf) => {
      out += String(buf);
    });
    p.stderr.on('data', (buf) => {
      err += String(buf);
    });
    p.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    p.on('close', (code) => {
      ended = true;
      clearTimeout(timer);
      done({ code, out, err });
    });
  });
}
function ps(script, args) {
  return child('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    resolve(scripts, script),
    ...args,
  ]);
}
function doc(out) {
  return JSON.parse(out.trim());
}

const secret = 'PRIVATE_PROMPT_CANARY_DO_NOT_ECHO';
const mock = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.url === '/system_stats')
    return res.end(
      JSON.stringify({
        system: {
          os: 'win32',
          comfyui_version: 'test-0.0.1',
          python_version: 'test-python',
          pytorch_version: 'test-torch',
        },
        devices: [{ name: 'test NVIDIA device', vram_total: 8 * 1024 ** 3 }],
      }),
    );
  if (req.url === '/queue')
    return res.end(
      JSON.stringify({
        queue_running: [{ prompt: { private: secret } }],
        queue_pending: [],
      }),
    );
  res.statusCode = 404;
  res.end('{}');
});
let ready = false;
try {
  await mkdir(fixtureDir, { recursive: true });
  await new Promise((resolveListen) => mock.listen(0, '127.0.0.1', resolveListen));
  ready = true;
  const port = mock.address().port;
  const check = await ps('Preflight-ComfyUI.ps1', [
    '-WorkspaceRoot',
    fixtureDir,
    '-ApiUrl',
    'http://127.0.0.1:' + port,
    '-SkipGpu',
  ]);
  assert.equal(check.code, 0, check.err);
  const preflight = doc(check.out);
  assert.equal(preflight.kind, 'dwb-comfyui-preflight-v1');
  assert.equal(preflight.comfyui.reachable, true);
  assert.equal(preflight.comfyui.version, 'test-0.0.1');
  assert.equal(preflight.comfyui.runningCount, 1);
  assert.equal(preflight.comfyui.pendingCount, 0);
  assert.equal(preflight.recommendedNextStep, 'reuse_existing_install');
  assert.equal(preflight.changesMade, false);
  assert.ok(!check.out.includes(secret), 'Never leak queued prompts to the Agent report');

  for (const api of [
    'http://example.com:8188',
    'http://192.168.1.9:8188',
    'https://127.0.0.1:8188',
  ]) {
    const invalid = await ps('Preflight-ComfyUI.ps1', [
      '-WorkspaceRoot',
      fixtureDir,
      '-ApiUrl',
      api,
      '-SkipGpu',
    ]);
    assert.notEqual(invalid.code, 0, api + ' should be rejected before networking');
  }

  const base = join(fixtureDir, 'source', 'ComfyUI_windows_portable');
  await mkdir(join(base, 'ComfyUI'), { recursive: true });
  await mkdir(join(base, 'python_embeded'), { recursive: true });
  await writeFile(join(base, 'ComfyUI', 'main.py'), 'print("test only")');
  await writeFile(join(base, 'python_embeded', 'python.exe'), '');
  await writeFile(join(base, 'run_nvidia_gpu.bat'), '@echo off\r\n');
  const archive = join(fixtureDir, 'fixture-portable.zip');
  const compressed = await child('tar.exe', [
    '-a',
    '-cf',
    archive,
    '-C',
    join(fixtureDir, 'source'),
    'ComfyUI_windows_portable',
  ]);
  assert.equal(compressed.code, 0, compressed.err);
  const wrongRoot = await ps('Install-ComfyUIPortable.ps1', [
    '-Action',
    'Plan',
    '-WorkspaceRoot',
    root,
    '-OfflineArchive',
    archive,
  ]);
  assert.notEqual(wrongRoot.code, 0, 'Must never install into DWB source repository');

  const args = [
    '-WorkspaceRoot',
    fixtureDir,
    '-InstallFolder',
    'isolated-demo',
    '-OfflineArchive',
    archive,
  ];
  const planned = await ps('Install-ComfyUIPortable.ps1', ['-Action', 'Plan', ...args]);
  assert.equal(planned.code, 0, planned.err);
  const plan = doc(planned.out);
  assert.equal(plan.kind, 'dwb-comfyui-install-plan-v1');
  assert.equal(plan.changesMade, false);
  assert.ok(/^[0-9a-f]{64}$/.test(plan.sha256));
  await assert.rejects(stat(join(fixtureDir, 'isolated-demo')), { code: 'ENOENT' });

  const unapproved = await ps('Install-ComfyUIPortable.ps1', [
    '-Action',
    'Apply',
    ...args,
    '-ApprovedSha256',
    plan.sha256,
  ]);
  assert.notEqual(unapproved.code, 0, 'Apply without explicit UserApproved must fail');
  const wrongHash = await ps('Install-ComfyUIPortable.ps1', [
    '-Action',
    'Apply',
    ...args,
    '-ApprovedSha256',
    'f'.repeat(64),
    '-UserApproved',
  ]);
  assert.notEqual(wrongHash.code, 0, 'Changed approval hash must fail');
  await assert.rejects(stat(join(fixtureDir, 'isolated-demo')), { code: 'ENOENT' });

  const invalidFolder = await ps('Install-ComfyUIPortable.ps1', [
    '-Action',
    'Plan',
    '-WorkspaceRoot',
    fixtureDir,
    '-InstallFolder',
    '../outside',
    '-OfflineArchive',
    archive,
  ]);
  assert.notEqual(invalidFolder.code, 0, 'Cannot escape the workspace root');

  const installed = await ps('Install-ComfyUIPortable.ps1', [
    '-Action',
    'Apply',
    ...args,
    '-ApprovedSha256',
    plan.sha256,
    '-UserApproved',
  ]);
  assert.equal(installed.code, 0, installed.err || installed.out);
  const result = doc(installed.out);
  assert.equal(result.status, 'installed_not_started');
  assert.equal(result.sha256Verified, true);
  assert.equal(result.changedExistingEnvironment, false);
  assert.equal((await stat(join(result.destination, 'ComfyUI', 'main.py'))).isFile(), true);
  assert.equal((await stat(join(result.destination, 'run_nvidia_gpu.bat'))).isFile(), true);
  const manifest = JSON.parse(
    (await readFile(join(result.destination, '.dwb-install-manifest.json'), 'utf8')).replace(
      /^\uFEFF/,
      '',
    ),
  );
  assert.equal(manifest.verifiedSha256, plan.sha256);
  assert.equal(manifest.autoStarted, false);
  const inspected = await ps('Start-ComfyUI-Isolated.ps1', [
    '-Action',
    'Inspect',
    '-InstallPath',
    result.destination,
    '-Port',
    String(port),
  ]);
  assert.equal(inspected.code, 0, inspected.err);
  const isolate = doc(inspected.out);
  assert.equal(isolate.kind, 'dwb-comfyui-isolated-instance-v1');
  assert.equal(isolate.gpuResourceShared, true, 'Portable is not a GPU sandbox');
  assert.equal(isolate.listen, '127.0.0.1');
  assert.equal(isolate.portBusy, true, 'Mock API port is already bound');
  assert.ok(isolate.paths.base.startsWith(result.destination));
  assert.ok(isolate.paths.models.startsWith(result.destination));
  assert.ok(isolate.paths.hfCache.startsWith(result.destination));
  assert.equal(isolate.changesMade, false);
  const reservedPort = await ps('Start-ComfyUI-Isolated.ps1', [
    '-Action',
    'Inspect',
    '-InstallPath',
    result.destination,
    '-Port',
    '8188',
  ]);
  assert.notEqual(reservedPort.code, 0, 'Port 8188 must be reserved for the existing instance');
  await assert.rejects(stat(join(result.destination, 'instance-data')), { code: 'ENOENT' });
  const startWithoutApproval = await ps('Start-ComfyUI-Isolated.ps1', [
    '-Action',
    'Launch',
    '-InstallPath',
    result.destination,
    '-Port',
    String(port),
  ]);
  assert.notEqual(startWithoutApproval.code, 0);
  const startWithOccupiedPort = await ps('Start-ComfyUI-Isolated.ps1', [
    '-Action',
    'Launch',
    '-InstallPath',
    result.destination,
    '-Port',
    String(port),
    '-UserApproved',
  ]);
  assert.notEqual(startWithOccupiedPort.code, 0, 'Running instance must not be replaced');
  await assert.rejects(stat(join(result.destination, 'instance-data')), { code: 'ENOENT' });
  const repeat = await ps('Install-ComfyUIPortable.ps1', [
    '-Action',
    'Apply',
    ...args,
    '-ApprovedSha256',
    plan.sha256,
    '-UserApproved',
  ]);
  assert.notEqual(repeat.code, 0, 'Never overwrite an existing installation');
  assert.equal((await stat(join(result.destination, 'ComfyUI', 'main.py'))).isFile(), true);

  console.log(
    'COMFYUI_SETUP_TEST_PASS: loopback privacy; isolated portable extraction; approval and SHA guards; port 8188 reserved; occupied-port launch blocked; no overwrite',
  );
} finally {
  if (ready) await new Promise((res) => mock.close(res));
  await rm(fixtureDir, { recursive: true, force: true });
}
