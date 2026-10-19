// Bundle the MCP Apps SDK and UI into one self-contained HTML resource.
// The sandbox cannot fetch local files or CDN JavaScript.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectCompanionNotices,
  companionNoticesPath,
  embedCompanionNotices,
} from './companion-notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const marker = '<!-- DWB_COMPANION_SCRIPT -->';
const logoMarker = '__DWB_COMPANION_LOGO__';
const template = await readFile(resolve(root, 'web/companion.html'), 'utf8');
if (!template.includes(marker)) throw new Error('Missing companion script marker.');
if (template.split(logoMarker).length !== 2)
  throw new Error('Expected exactly one companion logo marker.');
// MCP Apps render in an isolated iframe: file:// paths and local asset requests won't work.
// Inlining this small, resized copy keeps the original artwork self-contained and portable.
const logo = await readFile(resolve(root, 'web/companion-logo.png'));
if (logo.byteLength > 65536) throw new Error('Companion logo must be under 64 KiB.');
const logoDataUri = 'data:image/png;base64,' + logo.toString('base64');
const templateWithLogo = template.replace(logoMarker, () => logoDataUri);
const { outputFiles, metafile } = await build({
  entryPoints: [resolve(root, 'web/companion.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  metafile: true,
  logLevel: 'warning',
});
const script = outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
// IMPORTANT: pass a replacer callback. A string replacement expands `$&`, `$'`,
// and `$\`` tokens found in minified JS, which corrupts HTML by inserting copies
// of the surrounding document (and can prevent the MCP App from loading).
const html = templateWithLogo.replace(marker, () => '<script>' + script + '</script>');
const expectedLength =
  templateWithLogo.length - marker.length + script.length + '<script></script>'.length;
if (html.length !== expectedLength || html.includes(marker) || html.includes(logoMarker))
  throw new Error('Companion UI HTML interpolation was corrupted.');
const dist = resolve(root, 'dist');
const notices = await collectCompanionNotices(root, metafile);
const noticesFile = resolve(root, companionNoticesPath);
if (process.argv.includes('--update-notices')) {
  await writeFile(noticesFile, notices, 'utf8');
} else if ((await readFile(noticesFile, 'utf8')).replaceAll('\r\n', '\n') !== notices) {
  throw new Error(
    'Bundled notices are stale. Run node scripts/build-companion.mjs --update-notices and review the changes.',
  );
}
const licensedHtml = embedCompanionNotices(html, notices);
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, 'companion-panel.html'), licensedHtml, 'utf8');
console.log(
  'COMPANION_UI_BUILD_PASS (' +
    Buffer.byteLength(licensedHtml) +
    ' bytes, bundled notices verified)',
);
