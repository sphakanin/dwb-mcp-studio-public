import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const name = process.argv[2];
if (
  ![
    'setup-test',
    'tunnel-test',
    'external-test',
    'shell-test',
    'runtime-upgrade-test',
    'preferences-test',
    'skills-ui-test',
  ].includes(name)
)
  throw new Error('Unknown PowerShell test');
// npm launched from PowerShell 7 can pass its module search path into Windows
// PowerShell 5. Let the child initialize its own compatible module paths.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
);
const result = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    fileURLToPath(new URL(`${name}.ps1`, import.meta.url)),
  ],
  { env, windowsHide: true, stdio: 'inherit', timeout: 240000 },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
