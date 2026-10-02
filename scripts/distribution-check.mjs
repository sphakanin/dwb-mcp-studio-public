import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceDirectories = ['src', 'scripts', 'docs', 'assets', '.github'];

function publicPath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid distribution path: ' + path);
  if (
    path
      .split('/')
      .some((part) =>
        /^(?:\.git|\.env(?:\..*)?|node_modules|external|data|runtime|logs|engineering|experiments|brag-output.*|dataset|training(?:-.*)?)$/i.test(
          part,
        ),
      ) ||
    /\.(?:dpapi|key|pem|pfx|p12|log|safetensors|ckpt|pt|pth|onnx|ipynb|jsonl|mp4|mp3|wav)$/i.test(
      path,
    ) ||
    /(?:^|\/)RECORDING-SKILLS-TH\.md$/i.test(path)
  )
    throw new Error('Private or unrelated file cannot be distributed: ' + path);
  return path;
}

async function manifestFor(root) {
  const manifest = JSON.parse(
    await readFile(resolve(root, 'scripts/distribution-files.json'), 'utf8'),
  );
  if (manifest.developmentFiles.length)
    throw new Error('Internal development evidence must not be included in public source.');
  const all = [...manifest.files, ...manifest.launchers, ...manifest.developmentFiles];
  for (const path of all) publicPath(path);
  if (new Set(all).size !== all.length) throw new Error('Duplicate distribution manifest entry.');
  return manifest;
}

async function regularFile(root, path) {
  const info = await lstat(resolve(root, path));
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Distribution entries must be regular files: ' + path);
  if (info.size > 8 * 1024 * 1024) throw new Error('Unexpected large file in DWB source: ' + path);
}

// Every file under a shipped directory must be deliberately listed. Ignoring
// unrelated files at the root alone does not protect a recursive directory copy.
export async function sourceFiles(root = projectRoot, { launcher, workflows = true } = {}) {
  const manifest = await manifestFor(root);
  const declared = new Set(manifest.files);
  async function inspect(dir) {
    const directory = await lstat(resolve(root, dir));
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('Distribution directories must be real directories: ' + dir);
    for (const entry of await readdir(resolve(root, dir), { withFileTypes: true })) {
      const path = publicPath(dir + '/' + entry.name);
      if (entry.isSymbolicLink())
        throw new Error('Distribution directories cannot contain symlinks: ' + path);
      if (entry.isDirectory()) await inspect(path);
      else if (!entry.isFile() || !declared.has(path))
        throw new Error('File is not in the DWB distribution manifest: ' + path);
    }
  }
  for (const dir of sourceDirectories) {
    if (dir !== '.github' || workflows) await inspect(dir);
  }
  const files = manifest.files.filter((path) => workflows || !path.startsWith('.github/'));
  for (const path of files) await regularFile(root, path);
  if (launcher) {
    if (!manifest.launchers.includes(launcher))
      throw new Error('Unknown distribution launcher: ' + launcher);
    await regularFile(root, launcher);
    files.push(launcher);
  }
  return files.sort();
}

export async function checkDistribution(root = projectRoot) {
  const manifest = await manifestFor(root);
  const files = await sourceFiles(root);
  const allowed = new Set([...manifest.files, ...manifest.launchers, ...manifest.developmentFiles]);
  let gitRoot;
  try {
    gitRoot = await lstat(resolve(root, '.git'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (gitRoot) {
    const git = spawnSync(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (git.status !== 0)
      throw new Error(git.error?.message || git.stderr || 'Cannot inspect Git.');
    for (const path of new Set(git.stdout.split('\0').filter(Boolean))) {
      try {
        await lstat(resolve(root, path));
      } catch (error) {
        // Working-tree deletions are intentionally absent from the next release.
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      publicPath(path);
      if (!allowed.has(path)) throw new Error('Unreviewed file in public repository: ' + path);
      await regularFile(root, path);
    }
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const files = await checkDistribution();
    console.log('DISTRIBUTION_BOUNDARY_PASS ' + files.length + ' DWB source files');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
