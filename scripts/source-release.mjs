// Source distribution: no host-specific native binaries, Node modules, user data,
// API keys or third-party executables. POSIX executable bits survive a Windows build.
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDistribution, sourceFiles } from './distribution-check.mjs';

export async function createSourceRelease(platform, launcher) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await checkDistribution(root);
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const name = `dwb-mcp-studio-${pkg.version}-${platform}-source`;
  const files = await sourceFiles(root, { launcher });
  const table = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
  }
  const chunks = [],
    central = [];
  let offset = 0;
  for (const file of files.sort()) {
    if (/\.(?:dpapi|key|pem|pfx|log)$/i.test(file))
      throw new Error('Unexpected private file in source list.');
    let bytes = await readFile(resolve(root, file));
    if (/\.(command|sh)$/.test(file))
      bytes = Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'));
    const compressed = deflateRawSync(bytes),
      path = Buffer.from(`${name}/${file}`),
      crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(path.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(0x314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(bytes.length, 24);
    header.writeUInt16LE(path.length, 28);
    header.writeUInt32LE(((/\.(command|sh)$/.test(file) ? 0o100755 : 0o100644) * 65536) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    chunks.push(local, path, compressed);
    central.push(header, path);
    offset += local.length + path.length + compressed.length;
  }
  const index = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...chunks, index, end]);
  const output = resolve(root, 'releases', name + '.zip');
  await mkdir(resolve(root, 'releases'), { recursive: true });
  await writeFile(output, archive, { flag: 'wx' });
  const hash = createHash('sha256').update(archive).digest('hex');
  await writeFile(output + '.sha256', `${hash}  ${name}.zip\n`);
  console.log(
    `${platform.toUpperCase()}_SOURCE_RELEASE_PASS ${files.length} files\n${output}\nSHA256 ${hash}`,
  );
}
