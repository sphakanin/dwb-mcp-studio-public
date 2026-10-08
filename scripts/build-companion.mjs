// Bundle the MCP Apps SDK and UI into one self-contained HTML resource.
// The sandbox cannot fetch local files or CDN JavaScript.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const marker = '<!-- DWB_COMPANION_SCRIPT -->';
const template = await readFile(resolve(root, 'web/companion.html'), 'utf8');
if (!template.includes(marker)) throw new Error('Missing companion script marker.');
const { outputFiles } = await build({
  entryPoints: [resolve(root, 'web/companion.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  logLevel: 'warning',
});
const script = outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = template.replace(marker, '<script>' + script + '</script>');
const dist = resolve(root, 'dist');
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, 'companion-panel.html'), html, 'utf8');
console.log('COMPANION_UI_BUILD_PASS (' + Buffer.byteLength(html) + ' bytes)');
