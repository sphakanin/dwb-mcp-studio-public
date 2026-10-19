import { cp, mkdir, readFile, readdir, lstat, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerSuffix = join(
  'external',
  'desktop-commander',
  'node_modules',
  '@wonderwhy-er',
  'desktop-commander',
  'dist',
  'index.js',
);
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
};
export async function previousInstall(configFile, target = app) {
  try {
    const config = await json(configFile);
    const entry = resolve(config.workerEntry);
    if (!entry.toLowerCase().endsWith((sep + workerSuffix).toLowerCase())) return null;
    const root = entry.slice(0, -workerSuffix.length - 1);
    if (root.toLowerCase() === target.toLowerCase()) return null;
    if ((await json(join(root, 'package.json'))).name !== 'dwb-mcp-studio-core') return null;
    if (!(await exists(entry))) return null;
    return root;
  } catch {
    return null;
  }
}

// Stage complete directories before publishing them. Never move the old install,
// copy user data, or traverse links into another application's installation.
async function copyOwned(source, destination) {
  for (let path = resolve(source); dirname(path) !== path; path = dirname(path)) {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error('Cannot reuse an installation through a symbolic link or junction.');
  }
  for (let path = resolve(dirname(destination)); dirname(path) !== path; path = dirname(path)) {
    if ((await exists(path)) && (await lstat(path)).isSymbolicLink())
      throw new Error('Installation destination cannot use symbolic links or junctions.');
  }
  if (await exists(destination)) {
    if ((await lstat(destination)).isSymbolicLink())
      throw new Error('Installation destination cannot use symbolic links or junctions.');
    return false;
  }
  await mkdir(dirname(destination), { recursive: true });
  const stage = join(dirname(destination), '.upgrade-' + randomUUID());
  await cp(source, stage, {
    recursive: true,
    filter: async (path) => {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error('Cannot reuse dependencies containing symbolic links or junctions.');
      return true;
    },
  });
  // Windows can briefly reject publishing a freshly copied directory. Keep the
  // staged copy and retry only transient errors while the destination is absent.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(stage, destination);
      break;
    } catch (error) {
      if (
        attempt >= 5 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
        (await exists(destination))
      )
        throw error;
      await delay(100 * 2 ** attempt);
    }
  }
  return true;
}

export async function migrate(configFile, target = app) {
  const old = await previousInstall(configFile, target);
  const reused = [];
  if (!old) return reused;
  for (const component of ['desktop-commander', 'tunnel-client']) {
    const source = join(old, 'external', component);
    for (let path = source; dirname(path) !== path; path = dirname(path)) {
      if ((await exists(path)) && (await lstat(path)).isSymbolicLink())
        throw new Error('Cannot reuse an installation through a symbolic link or junction.');
    }
    let compatible = false;
    try {
      if (component === 'desktop-commander') {
        const pkg = await json(
          join(source, 'node_modules', '@wonderwhy-er', 'desktop-commander', 'package.json'),
        );
        compatible = pkg.name === '@wonderwhy-er/desktop-commander' && pkg.version === '0.2.50';
      } else {
        compatible = /^0\.0\.11(?:\+|\s|$)/.test(
          execFileSync(join(source, 'tunnel-client.exe'), ['--version'], {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
          }).trim(),
        );
      }
    } catch {}
    if (!compatible) continue;
    if ((await exists(source)) && (await copyOwned(source, join(target, 'external', component))))
      reused.push(component);
  }
  // Root package version changes on every release; the dependency graph must match.
  const graph = (lock) =>
    JSON.stringify(
      Object.entries(lock.packages)
        .filter(([key]) => key !== '')
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  try {
    if (
      graph(await json(join(old, 'package-lock.json'))) ===
        graph(await json(join(target, 'package-lock.json'))) &&
      (await exists(join(old, 'node_modules'))) &&
      (await copyOwned(join(old, 'node_modules'), join(target, 'node_modules')))
    )
      reused.push('DWB dependencies');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return reused;
}

async function fingerprint(
  root,
  paths = ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'dist', 'scripts'],
) {
  const hash = createHash('sha256');
  async function add(path) {
    if (!(await exists(join(root, path)))) return;
    const stat = await lstat(join(root, path));
    if (stat.isDirectory()) {
      for (const name of (await readdir(join(root, path))).sort()) await add(join(path, name));
    } else {
      hash.update(path);
      hash.update(await readFile(join(root, path)));
    }
  }
  for (const path of paths) await add(path);
  return hash.digest('hex');
}
export async function ready(root = app) {
  try {
    return (
      (await json(join(root, 'logs', 'setup-ready.json'))).fingerprint === (await fingerprint(root))
    );
  } catch {
    return false;
  }
}
export async function mark(root = app) {
  await mkdir(join(root, 'logs'), { recursive: true });
  await writeFile(
    join(root, 'logs', 'setup-ready.json'),
    JSON.stringify({
      fingerprint: await fingerprint(root),
      source: await fingerprint(root, ['src', 'tsconfig.json']),
      dist: await fingerprint(root, ['dist']),
    }),
  );
}
export async function needsBuild(root = app) {
  if (!(await exists(join(root, 'dist/index.js')))) return true;
  try {
    const marker = await json(join(root, 'logs', 'setup-ready.json'));
    return (
      marker.source !== (await fingerprint(root, ['src', 'tsconfig.json'])) &&
      marker.dist === (await fingerprint(root, ['dist']))
    );
  } catch {
    return false;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === 'check') console.log(await ready());
  else if (action === 'needs-build') console.log(await needsBuild());
  else if (action === 'mark') await mark();
  else if (action === 'migrate') console.log(JSON.stringify(await migrate(process.argv[3])));
  else throw new Error('Unknown upgrade operation');
}
