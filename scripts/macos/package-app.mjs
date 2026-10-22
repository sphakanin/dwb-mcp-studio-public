// Build only from the public allowlist in a fresh directory. Never copy a local
// node_modules, external installation, user profile, or Git history into an app.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkDistribution } from '../distribution-check.mjs';
import { run } from './common.mjs';

if (process.platform !== 'darwin') throw new Error('Package on a native Mac.');
const nodeVersion = '22.23.4';
const nodeHashes = {
  arm64: 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
  x64: 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
};
if (!nodeHashes[process.arch]) throw new Error('Unsupported Mac architecture.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const files = await checkDistribution(root);
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const releases = resolve(root, 'releases');
const name = `dwb-mcp-studio-${pkg.version}-macos-${process.arch}`;
const stage = resolve(releases, `.package-${randomUUID()}`);
const source = resolve(stage, 'source');
await mkdir(source, { recursive: true });
const inventory = [];
for (const file of files) {
  const bytes = await readFile(resolve(root, file));
  if (bytes.includes(Buffer.from(homedir()))) throw new Error('Build home path in source: ' + file);
  await mkdir(dirname(resolve(source, file)), { recursive: true });
  await writeFile(resolve(source, file), bytes);
  inventory.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const nodeName = `node-v${nodeVersion}-darwin-${process.arch}`;
const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${nodeName}.tar.gz`, {
  signal: AbortSignal.timeout(180000),
});
if (!response.ok) throw new Error('Official Node download failed: ' + response.status);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(archive).digest('hex') !== nodeHashes[process.arch])
  throw new Error('Official Node checksum mismatch.');
await writeFile(resolve(stage, 'node.tar.gz'), archive);
await run('/usr/bin/tar', ['-xzf', resolve(stage, 'node.tar.gz'), '-C', stage]);
const nodeRoot = resolve(stage, nodeName);
// C/C++ development headers are not needed by the installed JavaScript runtime.
await rm(resolve(nodeRoot, 'include'), { recursive: true, force: true });
const node = resolve(nodeRoot, 'bin/node');
const npm = resolve(nodeRoot, 'lib/node_modules/npm/bin/npm-cli.js');
// A private build HOME prevents loading the builder's npm credentials or config.
const buildHome = resolve(stage, 'build-home');
await mkdir(buildHome);
await writeFile(resolve(buildHome, 'user.npmrc'), '');
await writeFile(resolve(buildHome, 'global.npmrc'), '');
const env = {
  HOME: buildHome,
  TMPDIR: stage,
  LANG: 'en_US.UTF-8',
  PATH: `${resolve(nodeRoot, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
  npm_config_userconfig: resolve(buildHome, 'user.npmrc'),
  npm_config_globalconfig: resolve(buildHome, 'global.npmrc'),
  npm_config_cache: resolve(stage, 'npm-cache'),
};
const execute = (args) => run(node, args, { cwd: source, env, timeout: 600000 });
console.log('Installing clean build dependencies…');
await execute([npm, 'ci', '--no-audit', '--no-fund']);
console.log('Building the public source…');
await execute([npm, 'run', 'build']);
await execute(['scripts/macos/build-app.mjs', '--no-open']);
await execute([npm, 'prune', '--omit=dev', '--no-audit', '--no-fund']);
// Compiler bookkeeping and source maps are unnecessary in the installed runtime.
for (const entry of await readdir(resolve(source, 'dist')))
  if (
    entry === '.tsbuildinfo' ||
    entry.endsWith('.map') ||
    entry.endsWith('.d.ts') ||
    /-test\.js$/.test(entry)
  )
    await rm(resolve(source, 'dist', entry));
const volume = resolve(stage, 'volume');
await mkdir(volume);
const app = resolve(volume, 'DWB MCP Studio.app');
await rename(resolve(source, 'DWB MCP Studio.app'), app);
const resources = resolve(app, 'Contents/Resources');
await rename(source, resolve(resources, 'app'));
await rename(nodeRoot, resolve(resources, 'node'));
await writeFile(
  resolve(resources, 'runtime.json'),
  JSON.stringify({ node: 'node/bin/node', root: 'app' }) + '\n',
);
await writeFile(
  resolve(resources, 'app/packaged-runtime.json'),
  JSON.stringify({ format: 1, version: pkg.version, nodeVersion }) + '\n',
);
await writeFile(
  resolve(resources, 'source-inventory.json'),
  JSON.stringify(inventory, null, 2) + '\n',
);
await chmod(resolve(app, 'Contents/MacOS/DWBStudio'), 0o755);
await run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
await symlink('/Applications', resolve(volume, 'Applications'));
const output = resolve(releases, name + '.dmg');
// hdiutil refuses an existing output; a previous candidate is never overwritten.
await run(
  '/usr/bin/hdiutil',
  [
    'create',
    '-volname',
    'DWB MCP Studio',
    '-srcfolder',
    volume,
    '-format',
    'UDZO',
    '-fs',
    'HFS+',
    output,
  ],
  { timeout: 600000 },
);
await run('/usr/bin/hdiutil', ['verify', output], { timeout: 120000 });
const digest = createHash('sha256')
  .update(await readFile(output))
  .digest('hex');
await writeFile(output + '.sha256', `${digest}  ${name}.dmg\n`, { flag: 'wx' });
console.log(`MACOS_INSTALLER_PASS ${name}.dmg\nSHA256 ${digest}\nApp: ${app}`);
