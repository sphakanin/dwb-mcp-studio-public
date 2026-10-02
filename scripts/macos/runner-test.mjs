import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Process group test requires macOS.');
const dir = await mkdtemp(resolve(tmpdir(), 'dwb-runner-'));
await writeFile(
  resolve(dir, 'run'),
  `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync('pid.txt',String(child.pid)); setInterval(()=>{},1000);`,
);
const runner = spawn(
  process.execPath,
  [fileURLToPath(new URL('tunnel-runner.mjs', import.meta.url))],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
const exited = new Promise((done) => runner.once('exit', done));
let pid;
try {
  runner.stdin.write(
    JSON.stringify({
      executable: process.execPath,
      profile: 'unused',
      root: dir,
      env: process.env,
      key: 'fixture-only',
    }) + '\n',
  );
  for (let n = 0; n < 100; n++) {
    try {
      pid = Number(await readFile(resolve(dir, 'pid.txt'), 'utf8'));
      break;
    } catch {}
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.ok(pid, 'Fixture grandchild must start');
  runner.stdin.end();
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Runner did not stop')), 8000).unref(),
    ),
  ]);
  let alive = true;
  for (let n = 0; n < 100; n++) {
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
      break;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(alive, false, 'Grandchild must not survive supervisor shutdown');
  console.log('MAC_RUNNER_CLEANUP_PASS');
} finally {
  runner.stdin.end();
  if (runner.exitCode === null && runner.signalCode === null) runner.kill();
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}
