import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { acquireUnixBrokerLease } from '../../dist/unix-broker-lease.js';

const dir = await mkdtemp(resolve(tmpdir(), 'dwb-lease-test-'));
const endpoint = resolve(dir, 'broker.sock');
const moduleUrl = new URL('../../dist/unix-broker-lease.js', import.meta.url).href;
const child = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import { acquireUnixBrokerLease } from ${JSON.stringify(moduleUrl)}; const lease = acquireUnixBrokerLease(${JSON.stringify(endpoint)}); if (!lease) process.exit(2); console.log('LOCKED'); setInterval(()=>{},1000);`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
try {
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Lease holder timed out')), 10000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Lease holder exited before ready'));
    });
    child.stdout.once('data', (chunk) => {
      clearTimeout(timer);
      assert.match(String(chunk), /LOCKED/);
      resolveReady();
    });
  });
  assert.equal(
    acquireUnixBrokerLease(endpoint),
    null,
    'A competing process must not acquire the lease',
  );
  child.kill('SIGKILL');
  await exited;
  const recovered = acquireUnixBrokerLease(endpoint);
  assert.ok(recovered, 'A process crash must release the OS lock');
  recovered.close();
  console.log('UNIX_BROKER_LEASE_PASS');
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
