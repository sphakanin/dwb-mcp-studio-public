import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { configPath, readConfig, validateConfig } from './config.mjs';
import { defaultWorkerShell } from '../dist/paths.js';

const { values } = parseArgs({
  options: {
    'worker-entry': { type: 'string' },
    workspace: { type: 'string' },
    'worker-cap': { type: 'string' },
  },
});
const previous = await readConfig();
let prompt;
async function ask(label, old) {
  if (!process.stdin.isTTY)
    throw new Error(`Provide ${label} using command-line flags in non-interactive mode.`);
  prompt ??= createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question(`${label}${old ? ` [${old}]` : ''}: `)).trim();
  return (answer || old || '').replace(/^"(.*)"$/, '$1');
}
try {
  const workerEntry =
    values['worker-entry'] ||
    (await ask('Desktop Commander dist/index.js path', previous.workerEntry));
  const workspace = values.workspace || (await ask('Workspace directory', previous.workspace));
  const workerCap = Number(values['worker-cap'] || previous.workerCap || 4);
  const config = await validateConfig({ workerEntry, workspace, workerCap });
  const root = dirname(configPath());
  await mkdir(root, { recursive: true });
  // A newly configured install starts with an explicit filesystem policy.
  const basePolicy = previous.basePolicy || resolve(root, 'base-policy.json');
  const policy = {
    allowedDirectories: [config.workspace],
    defaultShell: defaultWorkerShell(),
    telemetryEnabled: false,
  };
  try {
    await writeFile(basePolicy, JSON.stringify(policy, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await validateConfig({ ...config, basePolicy });
  await writeFile(
    configPath(),
    JSON.stringify(
      {
        ...previous,
        workerEntry: config.workerEntry,
        workspace: config.workspace,
        workerCap: config.workerCap,
        basePolicy,
      },
      null,
      2,
    ) + '\n',
  );
  const clientConfig = resolve(root, 'mcp-client.json');
  const start = fileURLToPath(new URL('start.mjs', import.meta.url));
  await writeFile(
    clientConfig,
    JSON.stringify(
      {
        mcpServers: {
          'dwb-core': {
            command: process.execPath,
            args: [start],
            env: {
              DWB_CONFIG_FILE: configPath(),
              ...(process.env.DWB_DATA_DIR ? { DWB_DATA_DIR: process.env.DWB_DATA_DIR } : {}),
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
  if (process.platform === 'darwin') {
    console.log(
      `Saved configuration: ${configPath()}\nMCP client configuration: ${clientConfig}\nRun node scripts/macos/preview.mjs doctor to check the setup.`,
    );
  } else if (process.platform === 'linux')
    console.log(
      `Saved configuration: ${configPath()}\nMCP client configuration: ${clientConfig}\nRun node scripts/doctor.mjs to check the setup. See docs/UBUNTU-TH.md for VPS and systemd setup.`,
    );
  else
    console.log(
      `Saved configuration: ${configPath()}\nMCP client configuration: ${clientConfig}\nRun node scripts/doctor.mjs to check the setup.\nConnect your MCP client to the generated command. Use DWB MCP Studio.exe to open the app.`,
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  prompt?.close();
}
