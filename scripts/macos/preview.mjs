#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MacController } from './controller.mjs';
import { run } from './common.mjs';

try {
  if (process.platform !== 'darwin')
    throw new Error('This entry point is for macOS only. On Windows use DWB MCP Studio.exe.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16))
    throw new Error('Install Node.js 22.16 or newer with npm.');
  process.umask(0o077);
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { workspace: { type: 'string' }, 'worker-cap': { type: 'string' } },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !['setup', 'doctor', 'start', 'stop', 'test'].includes(command))
    throw new Error(
      'Usage: node scripts/macos/preview.mjs setup --workspace /absolute/folder [--worker-cap 4] | doctor | start | stop | test',
    );
  const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
  const data = resolve(
    process.env.DWB_DATA_DIR ||
      resolve(homedir(), 'Library/Application Support/DWB-MCP-Studio-Mac-Preview'),
  );
  process.env.DWB_DATA_DIR = data;
  process.env.DWB_CONFIG_FILE = resolve(data, 'config.json');
  for (const key of Object.keys(process.env))
    if (key.startsWith('DWB_') && !['DWB_DATA_DIR', 'DWB_CONFIG_FILE'].includes(key))
      delete process.env[key];
  if (command === 'setup' || command === 'stop') {
    await mkdir(data, { recursive: true, mode: 0o700 });
    const lease = new DatabaseSync(resolve(data, 'mac-control-lease.sqlite'));
    try {
      try {
        lease.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
      } catch {
        throw new Error(
          'The Mac app is open. Use its Setup/Stop buttons or quit it before using the CLI.',
        );
      }
      const controller = new MacController(
        root,
        data,
        resolve(root, 'DWB MCP Studio.app/Contents/MacOS/DWBStudio'),
      );
      if (command === 'setup')
        await controller.setup({
          workspace: values.workspace,
          workerCap: Number(values['worker-cap'] || 4),
        });
      else await controller.stop();
      console.log(
        command === 'setup'
          ? `Setup complete. Configuration: ${data}/mcp-client.json`
          : 'Broker stopped.',
      );
    } finally {
      lease.close();
    }
  } else if (command === 'start') await import('../start.mjs');
  else
    console.log(
      await run(
        process.execPath,
        [
          resolve(
            root,
            command === 'doctor' ? 'scripts/doctor.mjs' : 'scripts/macos/core-test.mjs',
          ),
        ],
        { cwd: root, timeout: 180000 },
      ),
    );
} catch (error) {
  console.error(`Mac: ${error.message}`);
  process.exitCode = 1;
}
