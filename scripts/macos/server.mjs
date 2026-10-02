import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MacController } from './controller.mjs';
import { cancelCommands, json, saveJson } from './common.mjs';

export function createControlServer(controller, token, onQuit = () => {}) {
  let origin;
  const assets = new Map([
    ['/', ['index.html', 'text/html']],
    ['/app.js', ['app.js', 'text/javascript']],
    ['/style.css', ['style.css', 'text/css']],
  ]);
  const server = createServer(async (req, res) => {
    const reply = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    try {
      origin = `http://127.0.0.1:${server.address().port}`;
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        return reply(403, { error: 'Untrusted origin.' });
      if (req.method === 'GET' && assets.has(req.url)) {
        const [file, type] = assets.get(req.url);
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        return res.end(await readFile(new URL(`ui/${file}`, import.meta.url)));
      }
      const supplied = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return reply(401, { error: 'Open this window from DWB MCP Studio.app.' });
      if (req.method === 'GET' && req.url === '/api/status')
        return reply(200, await controller.status());
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json')
        return reply(405, { error: 'JSON POST required.' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 32768) {
          reply(413, { error: 'Request too large.' });
          req.resume();
          return;
        }
      }
      const args = JSON.parse(body || '{}');
      if (!args || typeof args !== 'object' || Array.isArray(args))
        return reply(400, { error: 'Invalid request.' });
      let result;
      switch (req.url) {
        case '/api/setup':
          result = await controller.setup(args);
          break;
        case '/api/start':
          result = await controller.start(args);
          break;
        case '/api/stop':
          result = await controller.stop();
          break;
        case '/api/forget':
          result = await controller.exclusive(() => controller.forgetKey());
          break;
        case '/api/preferences':
          result = await controller.exclusive(() => controller.savePreferences(args));
          break;
        case '/api/quit':
          result = await controller.stop();
          reply(200, result);
          setTimeout(onQuit, 100);
          return;
        default:
          return reply(404, { error: 'Unknown action.' });
      }
      reply(200, result);
    } catch (error) {
      reply(400, { error: error.message });
    }
  });
  server.requestTimeout = 650000;
  server.headersTimeout = 10000;
  return server;
}

async function main() {
  if (process.platform !== 'darwin')
    throw new Error('The Mac control app requires macOS. On Windows use DWB MCP Studio.exe.');
  process.umask(0o077);
  const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
  const data = resolve(
    process.env.DWB_DATA_DIR ||
      resolve(homedir(), 'Library/Application Support/DWB-MCP-Studio-Mac-Preview'),
  );
  process.env.DWB_DATA_DIR = data;
  process.env.DWB_CONFIG_FILE = resolve(data, 'config.json');
  // Respect only the selected data directory; shell overrides must not redirect this UI's broker.
  for (const key of Object.keys(process.env))
    if (key.startsWith('DWB_') && !['DWB_DATA_DIR', 'DWB_CONFIG_FILE'].includes(key))
      delete process.env[key];
  await mkdir(data, { recursive: true, mode: 0o700 });
  const lease = new DatabaseSync(resolve(data, 'mac-control-lease.sqlite'));
  try {
    lease.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
  } catch {
    lease.close();
    throw new Error('DWB is already open for this data directory. Use its menu bar icon.');
  }
  const helper = resolve(root, 'DWB MCP Studio.app/Contents/MacOS/DWBStudio');
  const controller = new MacController(root, data, helper);
  const token = randomBytes(32).toString('base64url');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await cancelCommands();
    await controller.stopRunner();
    server.close();
    server.closeAllConnections();
    lease.close();
    process.exit(0);
  };
  const server = createControlServer(controller, token, () => void stop());
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const url = `http://127.0.0.1:${server.address().port}/#${token}`;
  await saveJson(resolve(data, 'mac-control.json'), { url, appRoot: root });
  console.log(url);
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  process.stdin.resume();
  process.stdin.on('end', () => void stop());
  if ((await json(resolve(data, 'mac-preferences.json'), {})).connectOnStartup) {
    controller.start(await json(resolve(data, 'mac-tunnel-settings.json'), {})).catch((error) => {
      controller.lastError = error.message;
    });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
