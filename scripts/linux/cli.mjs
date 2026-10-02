#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  cleanEnvironment,
  commitJsonFiles,
  json,
  run,
  saveJson,
  saveText,
} from '../posix-common.mjs';
import { assertOwned, installWorker } from '../posix-install.mjs';
import {
  linuxDataDir,
  readApiKey,
  tunnelProfile,
  validateApiKey,
  validateTunnelId,
} from './common.mjs';
import { installTunnel, tunnelAssets, tunnelPath } from './install.mjs';
import { renderService, serviceName, servicePath } from './service.mjs';

const usage = `Usage:
  bash install.sh --workspace /absolute/folder [--worker-cap 4]
  node scripts/linux/cli.mjs doctor
  node scripts/linux/cli.mjs tunnel-config --tunnel-id tunnel_... [--key-file /absolute/private-file]
  node scripts/linux/cli.mjs tunnel
  node scripts/linux/cli.mjs service install|start|stop|restart|status|name|uninstall

Use DWB_DATA_DIR to choose an isolated data directory. See docs/UBUNTU-TH.md.`;

async function promptKey() {
  if (!process.stdin.isTTY)
    throw new Error('Non-interactive setup requires --key-file /absolute/private-file.');
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const prompt = createInterface({ input: process.stdin, output: muted, terminal: true });
  const abort = new AbortController();
  prompt.once('SIGINT', () => abort.abort());
  process.stderr.write('Tunnel API key (hidden; saved in a private file): ');
  try {
    return validateApiKey(await prompt.question('', { signal: abort.signal }));
  } finally {
    process.stderr.write('\n');
    prompt.close();
  }
}
async function withLease(path, action) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lease = new DatabaseSync(path);
  try {
    try {
      lease.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    } catch {
      throw new Error(
        'Another installer or tunnel is using this installation. Stop it before reconfiguring.',
      );
    }
    return await action();
  } finally {
    lease.close();
  }
}
async function brokerStatus(root, env) {
  try {
    await access(resolve(root, 'dist/broker-protocol.js'));
  } catch {
    return { state: 'stopped' };
  }
  return JSON.parse(
    await run(process.execPath, [resolve(root, 'scripts/runtime-control.mjs')], { env }),
  );
}
async function assertBrokerStopped(root, env) {
  if ((await brokerStatus(root, env)).state !== 'stopped')
    throw new Error('Stop the service and disconnect local MCP clients before running Setup.');
}
async function setup(root, data, env, values) {
  if (!tunnelAssets[process.arch])
    throw new Error(`Unsupported Linux architecture: ${process.arch}`);
  if (!values.workspace || !isAbsolute(values.workspace))
    throw new Error('Provide --workspace /absolute/folder.');
  const workspace = await realpath(values.workspace);
  if (!(await stat(workspace)).isDirectory())
    throw new Error('Workspace must be an existing directory.');
  const previousConfig = await json(env.DWB_CONFIG_FILE, {});
  const cap = Number(values['worker-cap'] || previousConfig.workerCap || 4);
  if (!Number.isInteger(cap) || cap < 1 || cap > 64) throw new Error('Worker count must be 1–64.');
  await mkdir(data, { recursive: true, mode: 0o700 });
  await chmod(data, 0o700);
  await withLease(resolve(data, 'linux-control-lease.sqlite'), async () => {
    await assertBrokerStopped(root, env);
    const external = resolve(root, 'external');
    await assertOwned(external, external);
    await withLease(resolve(external, 'linux-install-lease.sqlite'), async () => {
      try {
        await access(resolve(root, 'node_modules/typescript/bin/tsc'));
      } catch {
        console.log('Installing DWB dependencies…');
        await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, env, timeout: 600000 });
      }
      console.log('Building DWB Core…');
      await run(
        process.execPath,
        [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
        { cwd: root, env },
      );
      await assertBrokerStopped(root, env);
      console.log('Installing Desktop Commander 0.2.50…');
      const workerEntry = await installWorker(root, 'linux');
      console.log('Installing verified Linux tunnel-client 0.0.11…');
      await installTunnel(root);
      const configFile = env.DWB_CONFIG_FILE;
      const previous = await json(configFile, {});
      const policyPath = previous.basePolicy || resolve(data, 'base-policy.json');
      if (!isAbsolute(policyPath))
        throw new Error('The saved basePolicy must be an absolute path.');
      const policy = await json(policyPath, {});
      if (
        policy.allowedDirectories !== undefined &&
        (!Array.isArray(policy.allowedDirectories) ||
          policy.allowedDirectories.some((path) => typeof path !== 'string' || !isAbsolute(path)))
      )
        throw new Error('Repair the saved allowedDirectories before running Setup.');
      const client = {
        mcpServers: {
          'dwb-core': {
            command: process.execPath,
            args: [resolve(root, 'scripts/start.mjs')],
            env: { DWB_DATA_DIR: data, DWB_CONFIG_FILE: configFile },
          },
        },
      };
      await commitJsonFiles([
        [
          policyPath,
          {
            telemetryEnabled: false,
            ...policy,
            allowedDirectories: [...new Set([...(policy.allowedDirectories || []), workspace])],
            defaultShell:
              !policy.defaultShell || policy.defaultShell === 'powershell.exe'
                ? '/bin/bash'
                : policy.defaultShell,
          },
        ],
        [
          configFile,
          { ...previous, workerEntry, workspace, workerCap: cap, basePolicy: policyPath },
        ],
        [resolve(data, 'mcp-client.json'), client],
      ]);
    });
  });
  console.log(
    `Ubuntu setup complete.\nData: ${data}\nLocal MCP config: ${resolve(data, 'mcp-client.json')}\nRun node scripts/linux/cli.mjs doctor, then configure your tunnel for VPS use.`,
  );
}
async function tunnelSettings(data) {
  const settings = await json(resolve(data, 'linux-tunnel-settings.json'), {});
  validateTunnelId(settings.tunnelId);
  return { ...settings, key: await readApiKey(settings.keyFile) };
}
async function checkConfig() {
  const { readConfig, validateConfig } = await import('../config.mjs');
  return validateConfig(await readConfig());
}
async function runTunnel(root, data, env) {
  await checkConfig();
  const runtime = await brokerStatus(root, env);
  if (runtime.state !== 'stopped' && (runtime.state !== 'running' || !runtime.matches))
    throw new Error(
      'A different or unresponsive broker is running. Stop it from its original installation.',
    );
  const settings = await tunnelSettings(data);
  const executable = tunnelPath(root);
  await assertOwned(resolve(root, 'external'), executable);
  if (
    !/^0\.0\.11(?:\+|\s|$)/.test(
      (await run(executable, ['--version'], { timeout: 5000, env })).trim(),
    )
  )
    throw new Error('Run Setup to install the supported tunnel-client.');
  const profile = resolve(data, 'tunnel-linux/profile.json');
  await saveJson(profile, tunnelProfile({ root, data, tunnelId: settings.tunnelId }));
  await unlink(resolve(data, 'tunnel-linux/health.url')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const child = spawn(executable, ['run', '--config', profile], {
    cwd: root,
    env: { ...env, DWB_TUNNEL_RUNTIME_KEY: settings.key },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  settings.key = '';
  let timer,
    stopping = false;
  const stop = () => {
    stopping = true;
    child.kill('SIGTERM');
    timer ??= setTimeout(() => child.kill('SIGKILL'), 10000);
    timer.unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', () => reject(new Error('Tunnel could not start. Run Setup and doctor.')));
      child.once('exit', (status) => done(stopping ? 0 : (status ?? 1)));
    });
    process.exitCode = code;
  } finally {
    clearTimeout(timer);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}
async function tunnelHealth(data) {
  try {
    const text = await readFile(resolve(data, 'tunnel-linux/health.url'), 'utf8');
    if (text.length > 1024) throw new Error();
    const url = new URL(text.trim());
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
      throw new Error();
    const response = await fetch(new URL('/readyz', url), {
      redirect: 'error',
      signal: AbortSignal.timeout(1000),
    });
    return response.status === 200 ? 'ready' : 'not-ready';
  } catch {
    return 'stopped-or-unreachable';
  }
}
async function service(action, root, data, env) {
  const name = serviceName(data);
  const path = servicePath(data, env);
  if (action === 'name') return console.log(name);
  if (action === 'install') {
    await checkConfig();
    await tunnelSettings(data);
    await saveText(path, renderService({ root, data }));
    await run('systemctl', ['--user', 'daemon-reload'], { env });
    await run('systemctl', ['--user', 'enable', name], { env });
    console.log(
      `Installed and enabled ${name}.\nRun node scripts/linux/cli.mjs service start to connect.\nFor operation after logout/reboot: sudo loginctl enable-linger ${process.env.USER || '<username>'}`,
    );
  } else if (action === 'uninstall') {
    await run('systemctl', ['--user', 'disable', '--now', name], { env });
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await run('systemctl', ['--user', 'daemon-reload'], { env });
    console.log(
      'Service removed. Configuration, workspaces and external components remain on disk.',
    );
  } else if (['start', 'stop', 'restart', 'status'].includes(action)) {
    if (action === 'start' || action === 'restart') {
      await checkConfig();
      await tunnelSettings(data);
    }
    const args =
      action === 'status'
        ? ['show', name, '--property=ActiveState,SubState,MainPID,Result']
        : [action, name];
    console.log(
      (await run('systemctl', ['--user', ...args], { env })).trim() || `Service ${action}: ${name}`,
    );
  } else throw new Error(usage);
}

try {
  if (process.platform !== 'linux') throw new Error('This entry point is for Ubuntu/Linux.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16))
    throw new Error('Install Node.js 22.16 or newer with npm.');
  process.umask(0o077);
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: 'string' },
      'worker-cap': { type: 'string' },
      'tunnel-id': { type: 'string' },
      'key-file': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(usage);
  else {
    const [command, action] = positionals;
    if (positionals.length !== (command === 'service' ? 2 : 1)) throw new Error(usage);
    const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
    const data = linuxDataDir();
    const env = {
      ...cleanEnvironment(),
      DWB_DATA_DIR: data,
      DWB_CONFIG_FILE: resolve(data, 'config.json'),
    };
    process.env = env;
    if (command === 'setup') await setup(root, data, env, values);
    else if (command === 'doctor') {
      const report = JSON.parse(
        await run(process.execPath, [resolve(root, 'scripts/doctor.mjs')], { env }),
      );
      report.tunnel = {
        state: await tunnelHealth(data),
        configured: Boolean((await json(resolve(data, 'linux-tunnel-settings.json'), {})).tunnelId),
      };
      report.service = serviceName(data);
      console.log(JSON.stringify(report, null, 2));
    } else if (command === 'tunnel-config') {
      await checkConfig();
      const tunnelId = validateTunnelId(values['tunnel-id']);
      await withLease(resolve(data, 'linux-control-lease.sqlite'), async () => {
        let keyFile = values['key-file'];
        if (keyFile) await readApiKey(keyFile);
        else {
          keyFile = resolve(data, 'tunnel-linux/api-key');
          await saveText(keyFile, (await promptKey()) + '\n');
        }
        await saveJson(resolve(data, 'linux-tunnel-settings.json'), { tunnelId, keyFile });
      });
      console.log(
        'Tunnel settings saved. Run tunnel for foreground use, or service install for VPS use.',
      );
    } else if (command === 'tunnel') {
      await withLease(resolve(data, 'linux-control-lease.sqlite'), () =>
        runTunnel(root, data, env),
      );
    } else if (command === 'service') await service(action, root, data, env);
    else throw new Error(usage);
  }
} catch (error) {
  console.error(`Ubuntu: ${error.message}`);
  process.exitCode = 1;
}
