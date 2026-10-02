import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { run } from './posix-common.mjs';

export function verifyArchive(bytes, expected) {
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Tunnel checksum mismatch. Nothing was installed.');
}
export async function assertOwned(root, target) {
  const base = resolve(root),
    path = resolve(target);
  if (path !== base && !path.startsWith(base + sep))
    throw new Error('External path escaped this installation.');
  let current = path;
  while (current.length >= base.length) {
    const info = await lstat(current).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (info?.isSymbolicLink())
      throw new Error('External installation cannot contain symbolic links.');
    if (current === base) break;
    current = dirname(current);
  }
}
export async function findBinary(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in tunnel archive.');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === 'tunnel-client') found.push(path);
    }
  }
  await walk(root);
  if (found.length !== 1) throw new Error('Tunnel archive must contain exactly one executable.');
  return found[0];
}
export async function installWorker(root, namespace = 'macos-preview') {
  if (!['macos-preview', 'linux'].includes(namespace))
    throw new Error('Unsupported installer namespace.');
  const external = resolve(root, 'external');
  const destination = resolve(external, namespace, 'desktop-commander');
  await assertOwned(external, destination);
  const entry = resolve(destination, 'node_modules/@wonderwhy-er/desktop-commander/dist/index.js');
  const { externalWorker } = await import('../dist/external-worker.js');
  try {
    externalWorker(entry);
    return entry;
  } catch {}
  const stage = resolve(external, `.${namespace}-worker-${randomUUID()}`);
  const backup = destination + `.backup-${randomUUID()}`;
  let moved = false;
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    await writeFile(resolve(stage, 'package.json'), JSON.stringify({ private: true }));
    await run(
      'npm',
      [
        'install',
        '--prefix',
        stage,
        '--no-audit',
        '--no-fund',
        '--save-exact',
        '@wonderwhy-er/desktop-commander@0.2.50',
      ],
      { cwd: root, timeout: 600000 },
    );
    externalWorker(resolve(stage, 'node_modules/@wonderwhy-er/desktop-commander/dist/index.js'));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await rename(destination, backup);
      moved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await rename(stage, destination);
    } catch (error) {
      if (moved) await rename(backup, destination);
      throw error;
    }
    return entry;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
