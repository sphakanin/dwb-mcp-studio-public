// The control app holds stdin open. EOF (including parent crash) ends only this
// runner's child process group; no persisted PID is trusted for termination.
import { spawn } from 'node:child_process';
let child,
  stopping = false,
  input = '',
  started = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child?.pid) process.exit(0);
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    process.exit(0);
  }, 3000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.setEncoding('utf8');
process.stdin.on('end', stop);
process.stdin.on('data', (chunk) => {
  if (started) return;
  input += chunk;
  if (input.length > 32768) {
    console.error('Invalid start request.');
    process.exit(1);
  }
  if (!input.includes('\n')) return;
  started = true;
  try {
    const request = JSON.parse(input.slice(0, input.indexOf('\n')));
    input = '';
    child = spawn(request.executable, ['run', '--config', request.profile], {
      cwd: request.root,
      env: { ...request.env, DWB_TUNNEL_RUNTIME_KEY: request.key },
      detached: true,
      stdio: 'ignore',
    });
    request.key = '';
    child.once('error', () => {
      console.error('Tunnel could not start.');
      process.exit(1);
    });
    child.once('spawn', () => console.log('STARTED'));
    child.once('exit', (code) => {
      // The direct child may exit before its descendants. Reap this owned group
      // before the runner exits so grandchildren cannot outlive the controller.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      process.exit(stopping ? 0 : code || 1);
    });
  } catch {
    console.error('Invalid start request.');
    process.exit(1);
  }
});
setTimeout(() => {
  if (!started) process.exit(1);
}, 10000).unref();
