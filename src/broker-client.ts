import { runtimeIdentity, sameRuntimePath } from './runtime-identity.js';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  brokerEndpoint,
  type BrokerLogicalContext,
  type BrokerRequest,
  type BrokerResponse,
} from './broker-protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const brokerEntry = resolve(projectRoot, 'dist', 'broker-server.js');
const endpoint = brokerEndpoint();

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);

async function connectOnce(timeoutMs = 400): Promise<Socket> {
  return new Promise<Socket>((resolveConnect, rejectConnect) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      rejectConnect(new Error(`Timed out connecting to DWB broker at ${endpoint}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolveConnect(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      rejectConnect(error);
    });
  });
}

function startBroker(): ChildProcess | undefined {
  if (process.env.DWB_BROKER_AUTOSTART === 'false') return;
  const child = spawn(process.execPath, [brokerEntry], {
    cwd: projectRoot,
    env: inheritedEnv,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.once('error', () => {});
  child.unref();
  return child;
}

async function connectWithAutostart(): Promise<Socket> {
  let candidate: ChildProcess | undefined;
  try {
    return await connectOnce();
  } catch {
    if (process.env.DWB_BROKER_AUTOSTART === 'false')
      throw new Error(`DWB broker is not running at ${endpoint}`);
    candidate = startBroker();
  }
  let last: unknown = null;
  let retryAt = Date.now() + 500;
  let retryDelay = 500;
  let starts = 1;
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    try {
      return await connectOnce(500);
    } catch (error) {
      last = error;
      // On Unix a broker draining its workers still owns the socket lease.
      // A competing start exits cleanly; retry it with bounded backoff once the
      // old broker can release the lease. Failed starts (exit 1) are not replayed.
      if (candidate?.exitCode === 0 && starts < 4 && Date.now() >= retryAt) {
        candidate = startBroker();
        starts += 1;
        retryDelay *= 2;
        retryAt = Date.now() + retryDelay;
      }
    }
  }
  throw new Error(`DWB broker did not become ready: ${String(last)}`);
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
};

export class BrokerClient {
  private readonly pending = new Map<string, Pending>();
  private buffer = '';
  private reconnectPromise: Promise<void> | null = null;
  private explicitlyClosed = false;
  sessionId: string | null = null;

  private constructor(
    private socket: Socket,
    private readonly cwd: string,
  ) {
    this.bindSocket(socket);
  }

  private bindSocket(socket: Socket): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (this.socket === socket) this.onData(chunk);
    });
    socket.on('close', () => {
      if (this.socket === socket) this.failPending(new Error('DWB broker connection closed'));
    });
    socket.on('error', (error) => {
      if (this.socket === socket) this.failPending(error);
    });
  }

  static async connect(cwd = process.cwd()): Promise<BrokerClient> {
    const socket = await connectWithAutostart();
    const client = new BrokerClient(socket, cwd);
    try {
      const hello = (await client.sendRaw(
        'hello',
        { cwd, adapterPid: process.pid },
        10_000,
      )) as any;
      client.verifyRuntime(hello);
      client.sessionId = hello.sessionId;
      return client;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  private verifyRuntime(hello: any): void {
    const running = hello?.broker?.runtime;
    if (
      running?.version !== runtimeIdentity.version ||
      !sameRuntimePath(running?.appRoot, runtimeIdentity.appRoot)
    )
      throw new Error(
        'DWB_RUNTIME_MISMATCH: another release is still running. Finish its work, Stop MCP, then open Setup in this release to update the broker. Saved settings are retained.',
      );
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: BrokerResponse;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.settle(message);
    }
  }

  private settle(message: BrokerResponse): void {
    if (typeof message.sessionId === 'string' && message.sessionId)
      this.sessionId = message.sessionId;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.cleanup();
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error?.message ?? 'Broker request failed');
      error.name = message.error?.code ?? 'BROKER_ERROR';
      pending.reject(error);
    }
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(
        new Error(
          'DWB_OUTCOME_UNKNOWN: broker connection was lost. Dispatched work may still finish; inspect status/files before retrying. ' +
            error.message,
        ),
      );
      this.pending.delete(id);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.explicitlyClosed) throw new Error('DWB broker client is closed');
    if (this.reconnectPromise) return this.reconnectPromise;
    if (!this.socket.destroyed) return;
    this.reconnectPromise = (async () => {
      const socket = await connectWithAutostart();
      this.buffer = '';
      this.socket = socket;
      this.bindSocket(socket);
      try {
        const hello = (await this.sendRaw(
          'hello',
          {
            cwd: this.cwd,
            adapterPid: process.pid,
            sessionId: this.sessionId,
          },
          10_000,
        )) as any;
        this.verifyRuntime(hello);
        this.sessionId = hello.sessionId;
      } catch (error) {
        socket.destroy();
        throw error;
      }
    })().finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  private sendRaw(
    method: BrokerRequest['method'],
    params?: Record<string, unknown>,
    timeoutMs = 120_000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.socket.destroyed) return Promise.reject(new Error('DWB broker connection is closed'));
    const id = randomUUID();
    const message: BrokerRequest = { id, method, params, deadline: Date.now() + timeoutMs };
    return new Promise((resolveRequest, rejectRequest) => {
      const cancel = () => {
        if (!this.socket.destroyed)
          this.socket.write(
            JSON.stringify({ id: randomUUID(), method: 'cancel', params: { requestId: id } }) +
              '\n',
          );
      };
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => {
        cleanup();
        this.pending.delete(id);
        cancel();
        rejectRequest(
          new Error(
            'DWB_OUTCOME_UNKNOWN: broker did not acknowledge the deadline. Waiting work is cancelled by the broker; dispatched work may still finish. Inspect status/files before retrying.',
          ),
        );
      }, timeoutMs + 1000);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer, cleanup });
      this.socket.write(JSON.stringify(message) + '\n');
    });
  }

  async request(
    method: BrokerRequest['method'],
    params?: Record<string, unknown>,
    timeoutMs = 120_000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.ensureConnected();
    return this.sendRaw(method, params, timeoutMs, signal);
  }

  listTools(context?: BrokerLogicalContext | null, signal?: AbortSignal): Promise<any> {
    return this.request('list_tools', context ? { context } : {}, 120_000, signal) as Promise<any>;
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    context?: BrokerLogicalContext | null,
    signal?: AbortSignal,
  ): Promise<any> {
    return this.request(
      'call_tool',
      {
        name,
        arguments: args,
        ...(context ? { context } : {}),
      },
      120_000,
      signal,
    ) as Promise<any>;
  }

  listResources(context?: BrokerLogicalContext | null, signal?: AbortSignal): Promise<any> {
    return this.request(
      'list_resources',
      context ? { context } : {},
      120_000,
      signal,
    ) as Promise<any>;
  }
  listResourceTemplates(context?: BrokerLogicalContext | null, signal?: AbortSignal): Promise<any> {
    return this.request(
      'list_resource_templates',
      context ? { context } : {},
      120_000,
      signal,
    ) as Promise<any>;
  }
  readResource(
    uri: string,
    context?: BrokerLogicalContext | null,
    signal?: AbortSignal,
  ): Promise<any> {
    return this.request(
      'read_resource',
      { uri, ...(context ? { context } : {}) },
      120_000,
      signal,
    ) as Promise<any>;
  }

  ping(): Promise<any> {
    return this.request('ping', {}, 5_000) as Promise<any>;
  }

  shutdownForTests(): Promise<any> {
    return this.request('shutdown', {}, 5_000) as Promise<any>;
  }

  async close(): Promise<void> {
    this.explicitlyClosed = true;
    if (this.socket.destroyed) return;
    await new Promise<void>((resolveClose) => {
      this.socket.end(() => resolveClose());
      setTimeout(() => {
        this.socket.destroy();
        resolveClose();
      }, 500).unref();
    });
  }
}
