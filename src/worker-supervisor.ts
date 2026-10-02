import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { externalWorker } from './external-worker.js';
import { EventLog } from './event-log.js';
import { persistBaseDcConfigValue } from './dc-config-policy.js';
import { PayloadGuard } from './payload-guard.js';
import { prepareWorkerHome } from './worker-home.js';

const here = dirname(fileURLToPath(import.meta.url));
const bootstrapEntry = resolve(here, 'worker-bootstrap.js');

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function searchListHasActiveWork(text: string): boolean {
  const output = text.trim();
  if (!output || /No active searches/i.test(output)) return false;

  const statuses = [...output.matchAll(/Status:\s*[^\r\nA-Za-z]*([A-Za-z_-]+)/gi)].map((match) =>
    match[1].toUpperCase(),
  );
  if (!statuses.length) return true;

  const terminal = new Set([
    'COMPLETED',
    'COMPLETE',
    'STOPPED',
    'TERMINATED',
    'CANCELLED',
    'CANCELED',
    'FAILED',
    'ERROR',
  ]);
  return statuses.some((status) => !terminal.has(status));
}

class WorkerCircuitOpenError extends Error {
  constructor(readonly retryAt: number) {
    super(`Desktop Commander worker circuit is open until ${new Date(retryAt).toISOString()}`);
    this.name = 'WorkerCircuitOpenError';
  }
}

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);

export type WorkerContext = {
  sessionId: string;
  workspaceKey: string;
  workerId: string;
};

export class WorkerSupervisor {
  private client: Client | null = null;
  private workerVersion = 'not-started';
  private transport: StdioClientTransport | null = null;
  private restartPromise: Promise<Client> | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlightTools = 0;
  private lastHealthyAt: string | null = null;
  private lastRestartReason: string | null = null;
  private restartCount = 0;
  private consecutiveStartFailures = 0;
  private circuitOpenUntil = 0;
  private readonly payloadGuard: PayloadGuard;
  private readonly maxSpawnAttempts = Math.max(1, envInt('DWB_WORKER_SPAWN_ATTEMPTS', 3));
  private readonly backoffBaseMs = Math.max(50, envInt('DWB_WORKER_BACKOFF_BASE_MS', 400));
  private readonly backoffMaxMs = Math.max(
    this.backoffBaseMs,
    envInt('DWB_WORKER_BACKOFF_MAX_MS', 5_000),
  );
  private readonly circuitThreshold = Math.max(1, envInt('DWB_WORKER_CIRCUIT_THRESHOLD', 5));
  private readonly circuitCooldownMs = Math.max(
    500,
    envInt('DWB_WORKER_CIRCUIT_COOLDOWN_MS', 20_000),
  );

  constructor(
    private readonly log: EventLog,
    private readonly context: WorkerContext = {
      sessionId: 'legacy',
      workspaceKey: process.cwd(),
      workerId: 'legacy-worker',
    },
    private readonly heartbeatMs = 15_000,
  ) {
    this.payloadGuard = new PayloadGuard(log);
  }

  get status() {
    return {
      ready: this.client !== null,
      bridgePid: process.pid,
      sessionId: this.context.sessionId,
      workerId: this.context.workerId,
      workspaceKey: this.context.workspaceKey,
      workerPid: this.transport?.pid ?? null,
      desktopCommanderVersion: this.workerVersion,
      heartbeatMs: this.heartbeatMs,
      restartCount: this.restartCount,
      lastHealthyAt: this.lastHealthyAt,
      lastRestartReason: this.lastRestartReason,
      consecutiveStartFailures: this.consecutiveStartFailures,
      circuitOpenUntil:
        this.circuitOpenUntil > Date.now() ? new Date(this.circuitOpenUntil).toISOString() : null,
      payloadGuard: this.payloadGuard.status,
    };
  }

  async start(): Promise<void> {
    await this.restart('startup');
    if (this.stopped) throw new Error('Bridge is stopping');
    this.heartbeat = setInterval(() => void this.probe().catch(() => {}), this.heartbeatMs);
    this.heartbeat.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.restartPromise?.catch(() => {});
    await this.closeWorker();
    await this.log.write({
      type: 'worker_stopped',
      sessionId: this.context.sessionId,
      workerId: this.context.workerId,
      workspaceKey: this.context.workspaceKey,
    });
  }

  private async closeWorker(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    try {
      await client?.close();
    } catch {}
    try {
      await transport?.close();
    } catch {}
  }

  async restart(reason: string): Promise<Client> {
    if (this.inFlightTools)
      throw new Error(
        'Worker has dispatched tool calls; wait for their actual results before restarting',
      );
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = this.recover(reason).finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  private async recover(reason: string): Promise<Client> {
    if (Date.now() < this.circuitOpenUntil) throw new WorkerCircuitOpenError(this.circuitOpenUntil);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxSpawnAttempts; attempt += 1) {
      try {
        const client = await this.spawn(reason);
        this.consecutiveStartFailures = 0;
        this.circuitOpenUntil = 0;
        return client;
      } catch (error) {
        if (this.stopped) throw new Error('Bridge is stopping');
        lastError = error;
        this.consecutiveStartFailures += 1;
        if (this.consecutiveStartFailures >= this.circuitThreshold) {
          this.circuitOpenUntil = Date.now() + this.circuitCooldownMs;
          await this.log.write({
            type: 'worker_circuit_open',
            sessionId: this.context.sessionId,
            workerId: this.context.workerId,
            workspaceKey: this.context.workspaceKey,
            reason,
            details: {
              consecutiveStartFailures: this.consecutiveStartFailures,
              retryAt: new Date(this.circuitOpenUntil).toISOString(),
            },
          });
          throw new WorkerCircuitOpenError(this.circuitOpenUntil);
        }
        if (attempt < this.maxSpawnAttempts) {
          const delayMs = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (attempt - 1));
          await this.log.write({
            type: 'worker_restart_backoff',
            sessionId: this.context.sessionId,
            workerId: this.context.workerId,
            workspaceKey: this.context.workspaceKey,
            reason,
            details: { attempt, delayMs, error: String(error) },
          });
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async spawn(reason: string): Promise<Client> {
    if (this.stopped) throw new Error('Bridge is stopping');
    await this.closeWorker();
    this.lastRestartReason = reason;
    const workerHome = await prepareWorkerHome(this.context.sessionId, this.context.workspaceKey);
    if (this.stopped) throw new Error('Bridge is stopping');
    const external = externalWorker();
    this.workerVersion = external.version;
    const workerEnv = {
      ...inheritedEnv,
      DWB_DC_CONFIG_HOME: workerHome,
      DWB_EXTERNAL_ENTRY: external.entry,
      DWB_CONFIG_TARGET: external.config,
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bootstrapEntry],
      env: workerEnv,
      cwd: this.context.workspaceKey,
      stderr: 'pipe',
      maxBufferSize: 10 * 1024 * 1024,
    });
    transport.stderr?.on('data', (chunk) => {
      process.stderr.write(
        `[desktop-commander:${this.context.sessionId.slice(0, 8)}] ${String(chunk)}`,
      );
    });

    const client = new Client({
      name: 'dwb-desktop-bridge-worker',
      version: '0.1.0',
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools(undefined, { timeout: 8_000 });
      if (this.stopped) throw new Error('Bridge is stopping');
      this.client = client;
      this.transport = transport;
      this.restartCount += 1;
      this.lastHealthyAt = new Date().toISOString();
      await this.log.write({
        type: 'worker_started',
        workerPid: transport.pid,
        reason,
        sessionId: this.context.sessionId,
        workerId: this.context.workerId,
        workspaceKey: this.context.workspaceKey,
        details: { toolCount: tools.tools.length, restartCount: this.restartCount },
      });
      return client;
    } catch (error) {
      await this.log.write({
        type: 'worker_start_failed',
        workerPid: transport.pid,
        reason,
        sessionId: this.context.sessionId,
        workerId: this.context.workerId,
        workspaceKey: this.context.workspaceKey,
        details: { error: String(error) },
      });
      try {
        await client.close();
      } catch {}
      try {
        await transport.close();
      } catch {}
      throw error;
    }
  }

  private async getClient(): Promise<Client> {
    return this.client ?? this.restart('worker_missing');
  }
  async listTools() {
    const client = await this.getClient();
    try {
      const result = await client.listTools(undefined, { timeout: 10_000 });
      this.lastHealthyAt = new Date().toISOString();
      return result;
    } catch (error) {
      await this.log.write({
        type: 'list_tools_failed',
        workerPid: this.transport?.pid ?? null,
        sessionId: this.context.sessionId,
        workerId: this.context.workerId,
        workspaceKey: this.context.workspaceKey,
        details: { error: String(error) },
      });
      const recovered = await this.restart('list_tools_failed');
      const result = await recovered.listTools(undefined, { timeout: 10_000 });
      this.lastHealthyAt = new Date().toISOString();
      return result;
    }
  }

  private async logUpstreamFailure(
    type: string,
    error: unknown,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.log.write({
      type,
      workerPid: this.transport?.pid ?? null,
      sessionId: this.context.sessionId,
      workerId: this.context.workerId,
      workspaceKey: this.context.workspaceKey,
      details: { ...details, error: String(error) },
    });
  }

  async listResources() {
    const client = await this.getClient();
    try {
      const result = await client.listResources(undefined, { timeout: 10_000 });
      this.lastHealthyAt = new Date().toISOString();
      return result;
    } catch (error) {
      await this.logUpstreamFailure('list_resources_failed', error);
      const recovered = await this.restart('list_resources_failed');
      const result = await recovered.listResources(undefined, { timeout: 10_000 });
      this.lastHealthyAt = new Date().toISOString();
      return result;
    }
  }

  async listResourceTemplates() {
    const client = await this.getClient();
    try {
      const result = await client.listResourceTemplates(undefined, { timeout: 10_000 });
      this.lastHealthyAt = new Date().toISOString();
      return result;
    } catch (error) {
      await this.logUpstreamFailure('list_resource_templates_failed', error);
      const recovered = await this.restart('list_resource_templates_failed');
      const result = await recovered.listResourceTemplates(undefined, { timeout: 10_000 });
      this.lastHealthyAt = new Date().toISOString();
      return result;
    }
  }

  async readResource(uri: string) {
    const client = await this.getClient();
    try {
      const result = await client.readResource({ uri }, { timeout: 10_000 });
      this.lastHealthyAt = new Date().toISOString();
      return result;
    } catch (error) {
      await this.logUpstreamFailure('read_resource_failed', error, { uri });
      const recovered = await this.restart('read_resource_failed');
      const result = await recovered.readResource({ uri }, { timeout: 10_000 });
      this.lastHealthyAt = new Date().toISOString();
      return result;
    }
  }

  async callTool(
    params: CallToolRequest['params'],
    meta: { requestId?: string; queueMs?: number; lockWaitMs?: number } = {},
  ) {
    const client = await this.getClient();
    const started = performance.now();
    this.inFlightTools++;
    try {
      // The broker owns the caller deadline. Do not let the SDK's default
      // 60-second timer discard a still-running result and release its locks.
      const result = await client.callTool(params, undefined, { timeout: 2_147_483_647 });
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!result.isError && params.name === 'set_config_value' && typeof args.key === 'string') {
        try {
          await persistBaseDcConfigValue(args.key, args.value);
        } catch (error) {
          const warning =
            'DWB_CONFIG_PERSIST_FAILED: the live worker changed, but the base policy could not be saved. ' +
            'A worker restart may restore the previous value. ' +
            String(error);
          const mutable = result as any;
          mutable.isError = true;
          mutable.content = [
            ...(Array.isArray(mutable.content) ? mutable.content : []),
            { type: 'text', text: warning },
          ];
          await this.log
            .write({
              type: 'config_persist_failed',
              workerPid: this.transport?.pid ?? null,
              tool: params.name,
              ok: false,
              sessionId: this.context.sessionId,
              requestId: meta.requestId,
              workerId: this.context.workerId,
              workspaceKey: this.context.workspaceKey,
              details: { key: args.key, error: String(error) },
            })
            .catch(() => {});
        }
      }
      const durationMs = Math.round(performance.now() - started);
      const application = await this.payloadGuard.apply(params.name, args, result);
      this.lastHealthyAt = new Date().toISOString();
      await this.log
        .write({
          type: 'tool_call',
          workerPid: this.transport?.pid ?? null,
          tool: params.name,
          durationMs,
          bytes: application.originalBytes,
          ok: !result.isError,
          sessionId: this.context.sessionId,
          requestId: meta.requestId,
          workerId: this.context.workerId,
          workspaceKey: this.context.workspaceKey,
          queueMs: meta.queueMs,
          lockWaitMs: meta.lockWaitMs,
          details: {
            forwardedBytes: application.forwardedBytes,
            guarded: application.guarded,
            archivePath: application.archivePath,
          },
        })
        .catch(() => {});
      return application.result;
    } catch (error) {
      await this.log
        .write({
          type: 'tool_call',
          workerPid: this.transport?.pid ?? null,
          tool: params.name,
          durationMs: Math.round(performance.now() - started),
          ok: false,
          sessionId: this.context.sessionId,
          requestId: meta.requestId,
          workerId: this.context.workerId,
          workspaceKey: this.context.workspaceKey,
          queueMs: meta.queueMs,
          lockWaitMs: meta.lockWaitMs,
          details: { error: String(error) },
        })
        .catch(() => {});
      throw new Error(
        'DWB_OUTCOME_UNKNOWN: upstream call failed; inspect files/processes before retrying. ' +
          String(error),
      );
    } finally {
      this.inFlightTools--;
    }
  }
  async hasActiveWork(): Promise<boolean> {
    if (this.inFlightTools) return true;
    const client = await this.getClient();
    const textOf = (result: any) =>
      Array.isArray(result?.content)
        ? result.content
            .filter((x: any) => x?.type === 'text')
            .map((x: any) => String(x.text ?? ''))
            .join('\n')
        : '';
    try {
      const sessions = await client.callTool({ name: 'list_sessions', arguments: {} }, undefined, {
        timeout: 3_000,
      });
      if (/PID:\s*\d+/i.test(textOf(sessions))) return true;
    } catch {
      return true;
    }
    try {
      const searches = await client.callTool({ name: 'list_searches', arguments: {} }, undefined, {
        timeout: 3_000,
      });
      if (searchListHasActiveWork(textOf(searches))) return true;
    } catch {
      return true;
    }
    return false;
  }

  private async probe(): Promise<void> {
    if (this.stopped || this.inFlightTools) return;
    try {
      const client = await this.getClient();
      await client.listTools(undefined, { timeout: 4_000 });
      this.lastHealthyAt = new Date().toISOString();
      await this.log.write({
        type: 'worker_heartbeat',
        workerPid: this.transport?.pid ?? null,
        sessionId: this.context.sessionId,
        workerId: this.context.workerId,
        workspaceKey: this.context.workspaceKey,
        details: { brokerPid: process.pid, lastHealthyAt: this.lastHealthyAt },
      });
    } catch (error) {
      await this.log.write({
        type: 'heartbeat_failed',
        workerPid: this.transport?.pid ?? null,
        sessionId: this.context.sessionId,
        workerId: this.context.workerId,
        workspaceKey: this.context.workspaceKey,
        details: { error: String(error) },
      });
      try {
        await this.restart('heartbeat_failed');
      } catch (restartError) {
        await this.log.write({
          type: 'recovery_failed',
          sessionId: this.context.sessionId,
          workerId: this.context.workerId,
          workspaceKey: this.context.workspaceKey,
          details: { error: String(restartError) },
        });
      }
    }
  }
}
