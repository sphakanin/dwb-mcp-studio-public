import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { run } from '../posix-common.mjs';
import { assertOwned, findBinary, verifyArchive } from '../posix-install.mjs';

// Official v0.0.11 release asset digests; never trust a checksum from the download itself.
export const tunnelAssets = Object.freeze({
  x64: {
    platform: 'amd64',
    sha256: '29adfe5c1399dfb9fda9383f230c324355912f50dc36e2e416b1f1322317b3c4',
  },
  arm64: {
    platform: 'arm64',
    sha256: 'd8bba47b2a723799a372b0b87d7e4d69304093d3a28837237315fe5406d97e77',
  },
});
export function tunnelPath(root) {
  return resolve(root, 'external/linux/tunnel-client/tunnel-client');
}
export async function installTunnel(root, arch = process.arch) {
  const asset = tunnelAssets[arch];
  if (!asset) throw new Error(`Unsupported Linux architecture: ${arch}`);
  const external = resolve(root, 'external');
  const destination = dirname(tunnelPath(root));
  await assertOwned(external, destination);
  try {
    if (
      /^0\.0\.11(?:\+|\s|$)/.test(
        (await run(tunnelPath(root), ['--version'], { timeout: 5000 })).trim(),
      )
    )
      return tunnelPath(root);
  } catch {}
  const stage = resolve(external, `.linux-tunnel-${randomUUID()}`);
  const backup = destination + `.backup-${randomUUID()}`;
  await mkdir(stage, { recursive: true, mode: 0o700 });
  let moved = false;
  try {
    const archive = resolve(stage, 'tunnel.zip');
    const unpacked = resolve(stage, 'unpacked');
    const limit = 64 * 1024 * 1024;
    await writeFile(archive, '', { mode: 0o600 });
    await run(
      'curl',
      [
        '--disable',
        '--fail',
        '--location',
        '--silent',
        '--show-error',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--retry',
        '2',
        '--connect-timeout',
        '20',
        '--max-time',
        '180',
        '--max-filesize',
        String(limit),
        '--output',
        archive,
        `https://github.com/openai/tunnel-client/releases/download/v0.0.11/tunnel-client-v0.0.11-linux-${asset.platform}.zip`,
      ],
      { timeout: 600000 },
    );
    if ((await stat(archive)).size > limit) throw new Error('Tunnel archive too large.');
    verifyArchive(await readFile(archive), asset.sha256);
    await run('unzip', ['-q', archive, '-d', unpacked]);
    const binary = await findBinary(unpacked);
    await chmod(binary, 0o700);
    if (!/^0\.0\.11(?:\+|\s|$)/.test((await run(binary, ['--version'], { timeout: 5000 })).trim()))
      throw new Error('Unexpected tunnel version.');
    // Keep upstream licenses and the optional cloudflared companion beside the executable.
    await chmod(resolve(dirname(binary), 'cloudflared'), 0o700).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await rename(destination, backup);
      moved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await rename(dirname(binary), destination);
    } catch (error) {
      if (moved) await rename(backup, destination);
      throw error;
    }
    return tunnelPath(root);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
