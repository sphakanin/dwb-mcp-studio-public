import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export function sameRuntimePath(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  return process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
}
export const runtimeIdentity = Object.freeze({
  version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    .version as string,
  appRoot: fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, ''),
  startedAt: new Date().toISOString(),
});
