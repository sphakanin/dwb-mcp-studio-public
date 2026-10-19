import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export const companionNoticesPath = 'assets/licenses/companion-THIRD-PARTY-NOTICES.txt';

// Use the bundle's actual inputs, including nested dependency installations.
// Do not infer attribution from only the top-level package.json dependencies.
export async function collectCompanionNotices(root, metafile) {
  const packagePaths = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const input of Object.keys(output.inputs)) {
      const match = input
        .replaceAll('\\', '/')
        .match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/);
      if (match) packagePaths.add(match[1]);
    }
  }
  if (!packagePaths.size) throw new Error('Companion bundle has no dependency attribution inputs.');
  const sections = [];
  for (const path of [...packagePaths].sort()) {
    const directory = resolve(root, path);
    const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    if (!pkg.name || !pkg.version) throw new Error('Missing dependency identity: ' + path);
    const files = (await readdir(directory))
      .filter((name) => /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(name))
      .sort();
    if (!files.some((name) => /^(?:licen[sc]e|copying)(?:[.-].*)?$/i.test(name)))
      throw new Error('Missing bundled dependency license: ' + pkg.name);
    const notices = [];
    for (const file of files) {
      const text = (await readFile(resolve(directory, file), 'utf8'))
        .replaceAll('\r\n', '\n')
        .trim();
      if (!text) throw new Error('Empty bundled dependency notice: ' + pkg.name + '/' + file);
      notices.push('--- ' + file + ' ---\n' + text);
    }
    sections.push({
      name: pkg.name + '@' + pkg.version,
      text:
        pkg.name +
        '@' +
        pkg.version +
        '\nDeclared license: ' +
        (pkg.license || 'See below') +
        '\n\n' +
        notices.join('\n\n'),
    });
  }
  sections.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return (
    'DWB Companion — bundled third-party notices\n\n' +
    'Generated from the actual Companion build inputs. Upstream license and NOTICE texts follow.\n' +
    'Regenerate deliberately with: node scripts/build-companion.mjs --update-notices\n\n' +
    sections.map((section) => section.text).join('\n\n' + '='.repeat(72) + '\n\n') +
    '\n'
  );
}

export function embedCompanionNotices(html, notices) {
  if (html.split('</body>').length !== 2) throw new Error('Expected one Companion body element.');
  const escaped = notices.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  // An inert template preserves notices even when the HTML resource is copied alone.
  return html.replace(
    '</body>',
    () => '<template id="dwb-third-party-notices"><pre>' + escaped + '</pre></template>\n</body>',
  );
}
