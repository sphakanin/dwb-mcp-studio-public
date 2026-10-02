import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { access, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  cleanEnvironment,
  commitJsonFiles,
  json,
  preferences,
  run,
  saveJson,
  shellQuote,
  xml,
} from './common.mjs';
import { assertOwned, installTunnel, installWorker } from './install.mjs';
import { recentEvents } from '../dashboard-probe.mjs';

export class MacController {
  constructor(root, data, helper) {
    this.root = root;
    this.data = data;
    this.helper = helper;
    this.configFile = resolve(data, 'config.json');
    this.tunnelDirectory = resolve(data, 'tunnel-macos');
    this.env = { ...cleanEnvironment(), DWB_DATA_DIR: data, DWB_CONFIG_FILE: this.configFile };
    this.runner = null;
    this.busy = false;
    this.lastError = '';
    this.progress = '';
    this.service =
      'com.dwb.mcp-studio.' + createHash('sha256').update(data).digest('hex').slice(0, 20);
  }
  async exclusive(action) {
    if (this.busy) throw new Error('Another operation is in progress.');
    this.busy = true;
    this.lastError = '';
    try {
      return await action();
    } catch (error) {
      this.lastError = error.message;
      throw error;
    } finally {
      this.busy = false;
      this.progress = '';
    }
  }
  async rpc(method) {
    let endpoint;
    let params;
    try {
      const module = await import('../../dist/broker-protocol.js');
      endpoint = module.brokerEndpoint();
      if (method === 'prepare_upgrade') {
        const { runtimeIdentity } = await import('../../dist/runtime-identity.js');
        params = { expectedRuntime: { version: runtimeIdentity.version, appRoot: this.root } };
      }
    } catch {
      return { state: 'stopped' };
    }
    return new Promise((done) => {
      const socket = createConnection(endpoint);
      let buffer = '',
        settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        done(value);
      };
      const timer = setTimeout(() => finish({ state: 'unresponsive' }), 5000);
      socket.setEncoding('utf8');
      socket.on('connect', () =>
        socket.write(JSON.stringify({ id: 'mac-control', method, params }) + '\n'),
      );
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 1024 * 1024) return finish({ state: 'unresponsive' });
        if (!buffer.includes('\n')) return;
        try {
          const message = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          if (message.id !== 'mac-control') throw new Error();
          finish(
            message.ok
              ? { state: 'running', ...message.result }
              : { state: 'blocked', error: message.error?.message || 'Broker is busy.' },
          );
        } catch {
          finish({ state: 'unresponsive' });
        }
      });
      socket.on('error', (error) =>
        finish({
          state: ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'stopped' : 'unresponsive',
        }),
      );
      socket.on('end', () => finish({ state: 'unresponsive' }));
    });
  }
  async matches(runtime) {
    if (runtime.state !== 'running') return runtime.state === 'stopped';
    const { runtimeIdentity, sameRuntimePath } = await import('../../dist/runtime-identity.js');
    return (
      runtime.broker?.runtime?.version === runtimeIdentity.version &&
      sameRuntimePath(runtime.broker?.runtime?.appRoot, this.root)
    );
  }
  async credential(operation, secret = '') {
    await access(this.helper).catch(() => {
      throw new Error('Build/open DWB MCP Studio.app to use macOS Keychain.');
    });
    // Secret travels through stdin, never argv, environment, profile, or logs.
    const output = await run(this.helper, ['--keychain'], {
      input: JSON.stringify({
        operation,
        service: this.service,
        account: 'tunnel-api-key',
        secret,
      }),
      timeout: 60000,
    });
    return JSON.parse(output);
  }
  async status() {
    const [config, settings, prefs, runtime] = await Promise.all([
      json(this.configFile, {}),
      json(resolve(this.data, 'mac-tunnel-settings.json'), {}),
      json(resolve(this.data, 'mac-preferences.json'), {}),
      this.rpc('inspect'),
    ]);
    let tunnel = this.runner ? 'starting' : 'stopped';
    if (this.runner && this.healthFile) {
      try {
        const url = new URL((await readFile(this.healthFile, 'utf8')).trim());
        if (
          url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          url.username ||
          url.password
        )
          throw new Error();
        const response = await fetch(new URL('/readyz', url), {
          redirect: 'error',
          signal: AbortSignal.timeout(800),
        });
        if (response.status === 200) tunnel = 'ready';
      } catch {}
    }
    return {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      configured: Boolean(config.workerEntry && config.workspace),
      workspace: config.workspace || '',
      workerCap: config.workerCap || 4,
      tunnel,
      tunnelId: settings.tunnelId || '',
      rememberKey: settings.rememberKey || false,
      preferences: preferences(prefs),
      runtime,
      runtimeMismatch: !(await this.matches(runtime)),
      busy: this.busy,
      progress: this.progress,
      error: this.lastError,
      events: await recentEvents(resolve(this.data, 'logs/events.jsonl')).catch(() => []),
      dataDirectory: this.data,
    };
  }
  async setup({ workspace, workerCap = 4 }) {
    return this.exclusive(async () => {
      let installLease;
      try {
        if (this.runner) throw new Error('Stop MCP before running Setup.');
        if ((await this.rpc('ping')).state !== 'stopped')
          throw new Error('Stop the broker and disconnect local MCP clients before running Setup.');
        if (typeof workspace !== 'string' || !workspace.startsWith('/'))
          throw new Error('Choose an absolute workspace directory.');
        const actual = await realpath(workspace);
        if (!(await stat(actual)).isDirectory()) throw new Error('Workspace is not a directory.');
        const cap = Number(workerCap);
        if (!Number.isInteger(cap) || cap < 1 || cap > 64)
          throw new Error('Worker count must be 1–64.');
        const external = resolve(this.root, 'external');
        await assertOwned(external, external);
        await mkdir(external, { recursive: true, mode: 0o700 });
        installLease = new DatabaseSync(resolve(external, 'mac-install-lease.sqlite'));
        try {
          installLease.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
        } catch {
          throw new Error('Another installer is using this source folder.');
        }
        this.progress = 'Installing core dependencies…';
        try {
          await access(resolve(this.root, 'node_modules/typescript/bin/tsc'));
        } catch {
          await run('npm', ['ci', '--no-audit', '--no-fund'], {
            cwd: this.root,
            env: this.env,
            timeout: 600000,
          });
        }
        this.progress = 'Building core…';
        await run(
          process.execPath,
          [resolve(this.root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
          { cwd: this.root, env: this.env },
        );
        this.progress = 'Installing Desktop Commander…';
        const workerEntry = await installWorker(this.root);
        this.progress = 'Installing verified tunnel-client…';
        await installTunnel(this.root);
        const previous = await json(this.configFile, {});
        const policyPath = previous.basePolicy || resolve(this.data, 'base-policy.json');
        const oldPolicy = await json(policyPath, null);
        if (
          oldPolicy &&
          (!Array.isArray(oldPolicy.allowedDirectories) ||
            oldPolicy.allowedDirectories.some(
              (path) => typeof path !== 'string' || !path.startsWith('/'),
            ))
        )
          throw new Error(
            'The saved filesystem policy is invalid. Repair base-policy.json before Setup.',
          );
        // Selecting a workspace explicitly authorizes it; retain other user policy values.
        const policy = {
          telemetryEnabled: false,
          ...oldPolicy,
          allowedDirectories: [...new Set([...(oldPolicy?.allowedDirectories || []), actual])],
          defaultShell:
            !oldPolicy?.defaultShell || oldPolicy.defaultShell === 'powershell.exe'
              ? '/bin/zsh'
              : oldPolicy.defaultShell,
        };
        const config = {
          ...previous,
          workerEntry,
          workspace: actual,
          workerCap: cap,
          basePolicy: policyPath,
        };
        const client = {
          mcpServers: {
            'dwb-core': {
              command: process.execPath,
              args: [resolve(this.root, 'scripts/start.mjs')],
              env: { DWB_DATA_DIR: this.data, DWB_CONFIG_FILE: this.configFile },
            },
          },
        };
        // Refresh login paths when moving/upgrading this source installation.
        await this.savePreferences(await json(resolve(this.data, 'mac-preferences.json'), {}));
        await commitJsonFiles([
          [policyPath, policy],
          [this.configFile, config],
          [resolve(this.data, 'mcp-client.json'), client],
        ]);
        return { ok: true };
      } finally {
        installLease?.close();
      }
    });
  }
  async start({ tunnelId, apiKey = '', rememberKey = false }) {
    return this.exclusive(async () => {
      if (this.runner) throw new Error('MCP is already running.');
      if (typeof tunnelId !== 'string' || !/^tunnel_[A-Za-z0-9_-]+$/.test(tunnelId))
        throw new Error('Enter a valid Tunnel ID beginning with tunnel_.');
      if (typeof rememberKey !== 'boolean' || typeof apiKey !== 'string')
        throw new Error('Invalid key settings.');
      const config = await json(this.configFile, {});
      const expectedWorker = resolve(
        this.root,
        'external/macos-preview/desktop-commander/node_modules/@wonderwhy-er/desktop-commander/dist/index.js',
      );
      if (config.workerEntry !== expectedWorker)
        throw new Error('Run Setup in this installation before Start MCP.');
      const { externalWorker } = await import('../../dist/external-worker.js');
      externalWorker(expectedWorker);
      if (!(await this.matches(await this.rpc('ping'))))
        throw new Error(
          'A different or unresponsive broker is running. Stop it from its original app first.',
        );
      let key = apiKey.trim();
      if (!key) key = (await this.credential('get')).secret || '';
      if (!key || /[\r\n\0]/.test(key) || key.length > 8192)
        throw new Error('Enter a valid API key.');
      const executable = resolve(this.root, 'external/macos-preview/tunnel-client/tunnel-client');
      await assertOwned(resolve(this.root, 'external'), executable);
      if (
        !/^0\.0\.11(?:\+|\s|$)/.test(
          (await run(executable, ['--version'], { timeout: 5000 })).trim(),
        )
      )
        throw new Error('Run Setup to install tunnel-client 0.0.11.');
      if (rememberKey) await this.credential('set', key);
      else {
        await this.credential('delete');
        const prefs = await json(resolve(this.data, 'mac-preferences.json'), {});
        await saveJson(resolve(this.data, 'mac-preferences.json'), {
          ...preferences(prefs),
          connectOnStartup: false,
        });
      }
      await mkdir(this.tunnelDirectory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      this.healthFile = resolve(this.tunnelDirectory, `${id}.health`);
      const profile = resolve(this.tunnelDirectory, 'profile.json');
      await saveJson(profile, {
        config_version: 1,
        control_plane: {
          base_url: 'https://api.openai.com',
          tunnel_id: tunnelId,
          api_key: 'env:DWB_TUNNEL_RUNTIME_KEY',
        },
        health: { listen_addr: '127.0.0.1:0', url_file: this.healthFile },
        admin_ui: { open_browser: false },
        log: { level: 'info', format: 'json', file: resolve(this.tunnelDirectory, `${id}.log`) },
        mcp: {
          commands: [
            {
              channel: 'main',
              command: [process.execPath, resolve(this.root, 'scripts/tunnel-mcp.mjs')]
                .map(shellQuote)
                .join(' '),
            },
          ],
        },
      });
      await saveJson(resolve(this.data, 'mac-tunnel-settings.json'), { tunnelId, rememberKey });
      const runner = spawn(
        process.execPath,
        [resolve(this.root, 'scripts/macos/tunnel-runner.mjs')],
        {
          cwd: this.root,
          env: this.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      this.runner = runner;
      runner.stdin.on('error', () => {});
      runner.once('exit', () => {
        if (this.runner === runner) {
          this.runner = null;
          this.lastError = 'Tunnel exited. Check the connection or API key, then Start MCP again.';
        }
      });
      try {
        await new Promise((ready, reject) => {
          const timer = setTimeout(() => reject(new Error('Tunnel startup timed out.')), 10000);
          const done = (fn) => (value) => {
            clearTimeout(timer);
            fn(value);
          };
          runner.once(
            'error',
            done(() => reject(new Error('Cannot start tunnel supervisor.'))),
          );
          runner.once(
            'exit',
            done(() => reject(new Error('Tunnel failed to start.'))),
          );
          runner.stdout.once(
            'data',
            done((chunk) =>
              String(chunk).includes('STARTED')
                ? ready()
                : reject(new Error('Unexpected tunnel supervisor response.')),
            ),
          );
          runner.stderr.resume();
          runner.stdin.write(
            JSON.stringify({ executable, profile, root: this.root, env: this.env, key }) + '\n',
          );
          key = '';
          apiKey = '';
        });
      } catch (error) {
        this.runner = null;
        runner.stdin.end();
        throw error;
      }
      return { ok: true, state: 'starting' };
    });
  }
  async stopRunner() {
    const runner = this.runner;
    this.runner = null;
    if (!runner) return;
    await new Promise((done) => {
      const timer = setTimeout(done, 5000);
      runner.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      runner.stdin.end();
    });
  }
  async stop() {
    return this.exclusive(async () => {
      await this.stopRunner();
      const runtime = await this.rpc('ping');
      if (runtime.state !== 'stopped') {
        if (!(await this.matches(runtime)))
          throw new Error(
            'Tunnel stopped. The broker belongs to another installation or is unresponsive.',
          );
        const result = await this.rpc('prepare_upgrade');
        if (result.state !== 'running')
          throw new Error(result.error || 'Tunnel stopped; broker could not shut down yet.');
      }
      return { ok: true };
    });
  }
  async forgetKey() {
    await this.credential('delete');
    const prefs = await json(resolve(this.data, 'mac-preferences.json'), {});
    await saveJson(resolve(this.data, 'mac-preferences.json'), {
      ...preferences(prefs),
      connectOnStartup: false,
    });
    const settings = await json(resolve(this.data, 'mac-tunnel-settings.json'), {});
    await saveJson(resolve(this.data, 'mac-tunnel-settings.json'), {
      ...settings,
      rememberKey: false,
    });
    return { ok: true };
  }
  async savePreferences(input) {
    const value = preferences(input);
    if (
      value.connectOnStartup &&
      !(await json(resolve(this.data, 'mac-tunnel-settings.json'), {})).rememberKey
    )
      throw new Error('Save the API key in Keychain before enabling automatic MCP connection.');
    const launchFile = resolve(homedir(), 'Library/LaunchAgents', `${this.service}.plist`);
    if (value.startAtLogin) {
      await access(this.helper);
      await mkdir(dirname(launchFile), { recursive: true, mode: 0o700 });
      await writeFile(
        launchFile,
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(this.service)}</string><key>ProgramArguments</key><array><string>${xml(this.helper)}</string><string>--background</string></array><key>RunAtLoad</key><true/><key>EnvironmentVariables</key><dict><key>DWB_DATA_DIR</key><string>${xml(this.data)}</string></dict></dict></plist>`,
        { mode: 0o600 },
      );
    } else
      await unlink(launchFile).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    await saveJson(resolve(this.data, 'mac-preferences.json'), value);
    return { ok: true };
  }
}
