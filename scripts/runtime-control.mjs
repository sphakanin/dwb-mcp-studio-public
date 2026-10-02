import { createConnection } from 'node:net';
import { brokerEndpoint } from '../dist/broker-protocol.js';
import { runtimeIdentity, sameRuntimePath } from '../dist/runtime-identity.js';

const method = process.argv[2] === 'prepare' ? 'prepare_upgrade' : 'ping';
const result = await new Promise((resolve) => {
  const socket = createConnection(brokerEndpoint());
  let buffer = '';
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(value);
  };
  const timer = setTimeout(() => finish({ state: 'unresponsive' }), 30000);
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(JSON.stringify({ id: 'runtime', method }) + '\n'));
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) return finish({ state: 'unresponsive' });
    if (!buffer.includes('\n')) return;
    try {
      const message = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      if (!message.ok) return finish({ state: 'blocked', error: message.error?.message });
      const broker = message.result?.broker;
      if (!Number.isInteger(broker?.brokerPid)) return finish({ state: 'unresponsive' });
      finish({
        state: 'running',
        broker,
        matches:
          broker.runtime?.version === runtimeIdentity.version &&
          sameRuntimePath(broker.runtime?.appRoot, runtimeIdentity.appRoot),
      });
    } catch {
      finish({ state: 'unresponsive' });
    }
  });
  socket.on('error', (error) =>
    finish({ state: ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'stopped' : 'unresponsive' }),
  );
  socket.on('end', () => finish({ state: 'unresponsive' }));
});
console.log(JSON.stringify(result));
