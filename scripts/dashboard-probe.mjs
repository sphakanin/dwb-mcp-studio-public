import { createConnection } from 'node:net';
import { open, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function inspectBroker(endpoint) {
  return new Promise((done) => {
    const socket = createConnection(endpoint);
    let buffer = '';
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      done(result);
    };
    const timer = setTimeout(() => finish({ state: 'unresponsive', sessions: [] }), 2000);
    socket.setEncoding('utf8');
    socket.on('connect', () =>
      socket.write(JSON.stringify({ id: 'dashboard', method: 'inspect' }) + '\n'),
    );
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return finish({ state: 'unresponsive', sessions: [] });
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end));
        if (reply.id !== 'dashboard') throw new Error('Unexpected reply');
        if (!reply.ok)
          return finish({
            state: /hello must be sent before|Unsupported broker method: inspect/.test(
              reply.error?.message ?? '',
            )
              ? 'upgrade-required'
              : 'unresponsive',
            sessions: [],
          });
        if (!reply.result?.broker || !Array.isArray(reply.result.sessions))
          throw new Error('Invalid snapshot');
        finish({ state: 'running', ...reply.result });
      } catch {
        finish({ state: 'unresponsive', sessions: [] });
      }
    });
    socket.on('error', (error) =>
      finish({
        state: ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'stopped' : 'unreachable',
        sessions: [],
      }),
    );
    socket.on('end', () => finish({ state: 'unresponsive', sessions: [] }));
  });
}

export function redact(value) {
  return String(value ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+[^\s,"'}]+/gi, 'Bearer [redacted]')
    .replace(
      /((?:api[_-]?key|token|password|secret)["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi,
      '$1[redacted]',
    )
    .slice(0, 500);
}

async function tail(path) {
  let file;
  try {
    file = await open(path, 'r');
    const { size } = await file.stat();
    const start = Math.max(0, size - 65536);
    const buffer = Buffer.alloc(Math.min(size, 65536));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.filter(Boolean).slice(-100);
  } catch {
    return [];
  } finally {
    await file?.close();
  }
}

export async function recentEvents(path) {
  const rows = [];
  for (const line of await tail(path)) {
    try {
      const item = JSON.parse(line);
      const failed = item.ok === false || /failed|error|fatal|circuit_open/.test(item.type ?? '');
      if (['worker_heartbeat', 'broker_heartbeat'].includes(item.type)) continue;
      rows.push({
        time: item.ts,
        event: redact(item.type),
        tool: redact(item.tool),
        status: failed ? 'error' : 'info',
        detail: redact(
          failed ? (item.details?.error ?? item.reason ?? item.type) : (item.reason ?? ''),
        ),
        session: item.sessionId ?? '',
      });
    } catch {}
  }
  return rows.reverse().slice(0, 30);
}

async function main() {
  try {
    const { dataDir } = await import('../dist/paths.js');
    const { runtimeIdentity, sameRuntimePath } = await import('../dist/runtime-identity.js');
    const { brokerEndpoint } = await import('../dist/broker-protocol.js');
    let config = {};
    try {
      config = JSON.parse(
        await readFile(process.env.DWB_CONFIG_FILE || resolve(dataDir(), 'config.json'), 'utf8'),
      );
    } catch {}
    const [runtime, events] = await Promise.all([
      inspectBroker(brokerEndpoint()),
      recentEvents(process.env.DWB_EVENT_LOG_PATH || resolve(dataDir(), 'logs', 'events.jsonl')),
    ]);
    // Read only the log recorded for DWB's own tunnel, never another profile.
    try {
      const tunnelRoot = resolve(dataDir(), 'tunnel');
      const state = JSON.parse(await readFile(resolve(tunnelRoot, 'process.json'), 'utf8'));
      const logPath = resolve(state.logFile);
      const inside = relative(tunnelRoot, logPath);
      if (inside && inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)) {
        for (const line of await tail(logPath)) {
          try {
            const row = JSON.parse(line);
            if (!/error|warn/i.test(row.level ?? '')) continue;
            events.push({
              time: row.time ?? row.ts,
              event: 'tunnel',
              tool: '',
              status: /warn/i.test(row.level) ? 'warn' : 'error',
              detail: redact([row.msg ?? row.message, row.error].filter(Boolean).join(' · ')),
            });
          } catch {}
        }
      }
    } catch {}
    events.sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
    console.log(
      JSON.stringify({
        ...runtime,
        runtimeMismatch:
          runtime.state === 'running' &&
          (runtime.broker?.runtime?.version !== runtimeIdentity.version ||
            !sameRuntimePath(runtime.broker?.runtime?.appRoot, runtimeIdentity.appRoot)),
        uiVersion: runtimeIdentity.version,
        events: events.slice(0, 30),
        initialWorkspace: config.workspace ?? '',
        workerCap: config.workerCap ?? null,
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch {
    console.log(
      JSON.stringify({
        state: 'setup-required',
        sessions: [],
        events: [],
        updatedAt: new Date().toISOString(),
      }),
    );
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
