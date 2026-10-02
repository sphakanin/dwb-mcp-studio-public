import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const commands = new Set();
export async function cancelCommands() {
  await Promise.all([...commands].map((command) => command.cancel()));
}

export async function json(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
export async function saveJson(path, value) {
  await saveText(path, JSON.stringify(value, null, 2) + '\n');
}
export async function saveText(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(pending, value, { mode: 0o600 });
    await rename(pending, path);
  } finally {
    await unlink(pending).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function commitJsonFiles(updates, persist = saveJson) {
  const originals = await Promise.all(
    updates.map(async ([path]) => [
      path,
      await readFile(path).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
    ]),
  );
  try {
    for (const [path, value] of updates) await persist(path, value);
  } catch (error) {
    const failures = [];
    for (const [path, bytes] of originals) {
      try {
        if (bytes === null)
          await unlink(path).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          });
        else await writeFile(path, bytes, { mode: 0o600 });
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    if (failures.length)
      throw new Error(
        'Saving configuration failed and rollback was incomplete. Check the data directory before retrying.',
      );
    throw error;
  }
}
export function run(command, args, { cwd, env = process.env, input, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      problem;
    const terminate = (signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const runningCommand = {
      cancel: () =>
        new Promise((done) => {
          problem = new Error('Operation cancelled.');
          child.once('close', done);
          terminate('SIGTERM');
          setTimeout(() => {
            terminate('SIGKILL');
            done();
          }, 3000).unref();
        }),
    };
    commands.add(runningCommand);
    const timer = setTimeout(() => {
      problem = new Error('Operation timed out.');
      terminate('SIGTERM');
      setTimeout(() => terminate('SIGKILL'), 3000).unref();
    }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) {
        problem = new Error('Unexpectedly large command output.');
        terminate('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      commands.delete(runningCommand);
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      commands.delete(runningCommand);
      clearTimeout(timer);
      if (problem) reject(problem);
      else if (code !== 0)
        reject(
          new Error(
            `Command failed (${code}): ${stderr.replace(/sk-[\w-]+|Bearer\s+\S+/g, '[redacted]')}`,
          ),
        );
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}
export function cleanEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        value !== undefined &&
        !/^(CONTROL_PLANE_|TUNNEL_CLIENT_|MCP_|HARPOON_|HEALTH_|ADMIN_UI_|CLOUDFLARED_|LOG_|DWB_)/i.test(
          key,
        ) &&
        !['OPENAI_API_KEY', 'OPEN_WEB_UI', 'ALLOW_REMOTE_UI'].includes(key),
    ),
  );
}
export function shellQuote(value) {
  if (/[\0\r\n]/.test(value)) throw new Error('Paths cannot contain newlines or NUL.');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
