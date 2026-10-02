import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { run } from './common.mjs';
import { assertOwned, findBinary, verifyArchive } from '../posix-install.mjs';
export { assertOwned, installWorker, verifyArchive } from '../posix-install.mjs';

export const tunnelAssets = Object.freeze({
  arm64: {
    platform: 'arm64',
    sha256: '3685443b057614ff932d2d477dab94be2082e60bcf4e8b4e378bebc89121b714',
  },
  x64: {
    platform: 'amd64',
    sha256: 'a48c8a37983d9bf9442309cb661cd2f14d7321cfacf72375d7fa31a6a7420db0',
  },
});
export async function installTunnel(root, arch = process.arch) {
  const asset = tunnelAssets[arch];
  if (!asset) throw new Error(`Unsupported Mac architecture: ${arch}`);
  const external = resolve(root, 'external');
  const destination = resolve(external, 'macos-preview', 'tunnel-client', 'tunnel-client');
  await assertOwned(external, destination);
  try {
    if (
      /^0\.0\.11(?:\+|\s|$)/.test((await run(destination, ['--version'], { timeout: 5000 })).trim())
    )
      return destination;
  } catch {}
  const stage = resolve(external, `.mac-tunnel-${randomUUID()}`);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    const response = await fetch(
      `https://github.com/openai/tunnel-client/releases/download/v0.0.11/tunnel-client-v0.0.11-darwin-${asset.platform}.zip`,
      { signal: AbortSignal.timeout(180000) },
    );
    if (!response.ok) throw new Error(`Tunnel download failed (${response.status}).`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Tunnel archive too large.');
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    verifyArchive(bytes, asset.sha256);
    const archive = resolve(stage, 'tunnel.zip'),
      unpacked = resolve(stage, 'unpacked');
    await writeFile(archive, bytes, { mode: 0o600 });
    // Only the exact pinned upstream archive is ever extracted.
    await run('/usr/bin/ditto', ['-x', '-k', archive, unpacked]);
    const binary = await findBinary(unpacked);
    await chmod(binary, 0o700);
    if (!/^0\.0\.11(?:\+|\s|$)/.test((await run(binary, ['--version'], { timeout: 5000 })).trim()))
      throw new Error('Unexpected tunnel version.');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const pending = destination + '.pending';
    await copyFile(binary, pending);
    await chmod(pending, 0o700);
    await rename(pending, destination);
    return destination;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
