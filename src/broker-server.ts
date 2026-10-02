import { RequestLifetime } from './request-lifetime.js';
import { acquireUnixBrokerLease } from './unix-broker-lease.js';
import { runtimeIdentity, sameRuntimePath } from './runtime-identity.js';
import { createServer, type Socket } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import {
  brokerEndpoint,
  BROKER_PROTOCOL_VERSION,
  type BrokerLogicalContext,
  type BrokerRequest,
  type BrokerResponse,
} from './broker-protocol.js';
import { brokerTools, textResult, NOT_A_CONTROL_TOOL } from './broker-tools.js';
import { EventLog } from './event-log.js';
import { SessionRegistry } from './session-registry.js';
import { CoreStore } from './core-store.js';
import { WorkspaceStore, pathWithin } from './workspace-store.js';
import { SkillStore, type SkillPolicy } from './skill-store.js';
import {
  RECOMMENDED_SKILLS,
  installGitHubSkill,
  installRecommendedSkill,
} from './skill-sources.js';
import { PayloadGuard } from './payload-guard.js';

const endpoint = brokerEndpoint();
let unixLease: ReturnType<typeof acquireUnixBrokerLease>;
const log = new EventLog();
const skillPayloadGuard = new PayloadGuard(log);
let coreDb: CoreStore;
let workspaceStore: WorkspaceStore;
let skillStore: SkillStore;
let registry: SessionRegistry;
const sockets = new Set<Socket>();
let markReady!: () => void;
const ready = new Promise<void>((resolve) => {
  markReady = resolve;
});

type ConnectionContext = {
  sessionId: string | null;
  adapterPid: number | null;
  initializing: boolean;
  closed: boolean;
  routingChange: Promise<void> | null;
};

function response(socket: Socket, message: BrokerResponse): void {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
}

function errorResponse(id: string, error: unknown): BrokerResponse {
  const err = error instanceof Error ? error : new Error(String(error));
  return { id, ok: false, error: { code: err.name || 'BROKER_ERROR', message: err.message } };
}

function callParams(message: BrokerRequest) {
  const params = message.params ?? {};
  if (typeof params.name !== 'string') throw new Error('call_tool requires a tool name');
  return { name: params.name, arguments: (params.arguments ?? {}) as Record<string, unknown> };
}

function skillPolicy(value: unknown): SkillPolicy {
  if (value === 'auto' || value === 'ask' || value === 'manual') return value;
  throw new Error('Skill policy must be auto, ask, or manual.');
}

function argText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function skillReadNumber(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new Error(`${name} must be a number.`);
  return value;
}

function requestContext(message: BrokerRequest): BrokerLogicalContext | null {
  const raw = message.params?.context;
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.key !== 'string' || !value.key.trim()) return null;
  return {
    key: value.key.trim(),
    source: typeof value.source === 'string' ? value.source : 'unknown',
    preview: typeof value.preview === 'string' ? value.preview : undefined,
    metaKeys: Array.isArray(value.metaKeys)
      ? value.metaKeys.filter((x): x is string => typeof x === 'string').slice(0, 40)
      : undefined,
  };
}

async function controlTool(
  ctx: ConnectionContext,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  requestId?: string,
): Promise<unknown | typeof NOT_A_CONTROL_TOOL> {
  if (!ctx.sessionId) throw new Error('MCP session is not initialized');
  if (name === 'dwb_bridge_status') {
    const session = registry.sessionStatus(sessionId) as any;
    const worker = session.workerStatus ?? {};
    const logicalWorkspace = workspaceStore.current(sessionId);
    return textResult({
      ...worker,
      ...session,
      logicalWorkspace,
      broker: registry.status,
      session: { ...session, logicalWorkspace },
    });
  }
  if (name === 'dwb_broker_status') return textResult(registry.status);
  if (name === 'dwb_session_status') {
    return textResult({
      ...registry.sessionStatus(sessionId),
      logicalWorkspace: workspaceStore.current(sessionId),
    });
  }
  if (name === 'dwb_restart_worker') return textResult(await registry.restartWorker(sessionId));
  if (name === 'dwb_list_sessions')
    return textResult({
      sessions: registry.listSessions().map((session: any) => ({
        ...session,
        logicalWorkspace: workspaceStore.current(String(session.sessionId)),
      })),
    });
  if (name === 'dwb_list_detached_sessions') {
    return textResult({
      sessions: registry.listDetached().map((session: any) => ({
        ...session,
        logicalWorkspace: workspaceStore.current(String(session.sessionId)),
      })),
    });
  }
  if (name === 'skills') {
    const action = argText(args.action);
    const workspace = workspaceStore.current(sessionId);
    if (action === 'list') return textResult({ workspace, skills: skillStore.list(workspace?.id) });
    if (action === 'catalog') return textResult({ skills: RECOMMENDED_SKILLS });

    if (action === 'install_github' || action === 'install_recommended') {
      if (args.explicit_user_request !== true)
        throw new Error(
          'DWB_SKILL_REMOTE_INSTALL_REQUIRES_USER_REQUEST: remote Skill installs require an explicit user request.',
        );
      if (action === 'install_github') {
        const githubUrl = argText(args.github_url);
        if (!githubUrl) throw new Error('github_url is required.');
        const rawPolicy = argText(args.policy);
        return textResult({
          installed: await installGitHubSkill(skillStore, githubUrl, {
            defaultPolicy: rawPolicy ? skillPolicy(rawPolicy) : undefined,
          }),
        });
      }
      const skill = argText(args.skill);
      if (!skill) throw new Error('skill is required.');
      return textResult({ installed: await installRecommendedSkill(skillStore, skill) });
    }

    if (action === 'install_local') {
      if (!workspace) throw new Error('DWB_SKILL_WORKSPACE_REQUIRED: bind a workspace first.');
      const source = argText(args.path);
      if (!source || !isAbsolute(source))
        throw new Error('install_local requires an absolute path.');
      if (!pathWithin(workspace.root, source))
        throw new Error(
          'DWB_SKILL_SOURCE_OUTSIDE_WORKSPACE: local installs must come from the bound workspace.',
        );
      const rawPolicy = argText(args.policy);
      const installed = await skillStore.installLocal({
        sourceDir: source,
        defaultPolicy: rawPolicy ? skillPolicy(rawPolicy) : undefined,
      });
      return textResult({ installed });
    }

    if (action === 'set_default_policy') {
      const skill = argText(args.skill);
      if (!skill) throw new Error('skill is required.');
      return textResult({
        skill: await skillStore.setDefaultPolicy(skill, skillPolicy(args.policy)),
      });
    }

    if (!workspace) throw new Error('DWB_SKILL_WORKSPACE_REQUIRED: bind a workspace first.');
    if (action === 'set_workspace_policy') {
      const skill = argText(args.skill);
      if (!skill) throw new Error('skill is required.');
      return textResult({
        skill: await skillStore.setWorkspacePolicy(workspace.id, skill, skillPolicy(args.policy)),
      });
    }
    if (action === 'clear_workspace_policy') {
      const skill = argText(args.skill);
      if (!skill) throw new Error('skill is required.');
      return textResult({ skill: skillStore.clearWorkspacePolicy(workspace.id, skill) });
    }
    if (action === 'activate') {
      const skill = argText(args.skill);
      if (!skill) throw new Error('skill is required.');
      return textResult(
        skillStore.activate({
          sessionId,
          workspaceId: workspace.id,
          skillId: skill,
          explicitUserRequest: args.explicit_user_request === true,
          userConfirmed: args.user_confirmed === true,
          approvalId: argText(args.approval_id) || undefined,
        }),
      );
    }
    if (action === 'read_file') {
      const skill = argText(args.skill);
      const relativePath = argText(args.relative_path);
      if (!skill || !relativePath) throw new Error('skill and relative_path are required.');
      return textResult({
        skill,
        relativePath,
        ...(await skillStore.readActivatedSkillPage(
          sessionId,
          workspace.id,
          skill,
          relativePath,
          args.offset === undefined ? undefined : skillReadNumber(args.offset, 'offset'),
          args.length === undefined ? undefined : skillReadNumber(args.length, 'length'),
        )),
      });
    }
    throw new Error(
      'skills.action must be one of: list, catalog, install_local, install_github, install_recommended, set_default_policy, set_workspace_policy, clear_workspace_policy, activate, read_file.',
    );
  }
  if (name === 'workspace') return textResult(await registry.workspace(sessionId, args));
  if (name === 'dwb_resume_session') {
    const target = args.session_id;
    if (typeof target !== 'string' || !target) throw new Error('session_id is required');
    let resumedId: string;
    ctx.routingChange = registry.resume(sessionId, target, ctx.adapterPid).then(async (id) => {
      resumedId = id;
      if (sessionId === ctx.sessionId) ctx.sessionId = id;
      if (ctx.closed && ctx.sessionId) await registry.detach(ctx.sessionId);
    });
    try {
      await ctx.routingChange;
      return textResult({ resumed: true, session: registry.sessionStatus(resumedId!) });
    } finally {
      ctx.routingChange = null;
    }
  }
  return NOT_A_CONTROL_TOOL;
}

async function handle(
  ctx: ConnectionContext,
  message: BrokerRequest,
  lifetime: RequestLifetime,
): Promise<unknown> {
  await ready;
  await ctx.routingChange?.catch(() => {});
  lifetime.check();
  if (ctx.closed || shuttingDown) throw new Error('Broker connection is closing');
  if (message.method === 'hello') {
    if (ctx.sessionId || ctx.initializing) throw new Error('Connection already initialized');
    ctx.initializing = true;
    const cwd = typeof message.params?.cwd === 'string' ? message.params.cwd : process.cwd();
    const adapterPid =
      typeof message.params?.adapterPid === 'number' ? message.params.adapterPid : null;
    const preferredSessionId =
      typeof message.params?.sessionId === 'string' ? message.params.sessionId : null;
    ctx.adapterPid = adapterPid;
    try {
      ctx.sessionId = await registry.attach(cwd, adapterPid, preferredSessionId);
      if (ctx.closed) await registry.detach(ctx.sessionId);
    } finally {
      ctx.initializing = false;
    }
    return {
      protocolVersion: BROKER_PROTOCOL_VERSION,
      sessionId: ctx.sessionId,
      broker: registry.status,
    };
  }
  if (message.method === 'prepare_upgrade') {
    const expected = message.params?.expectedRuntime as
      { version?: unknown; appRoot?: unknown } | undefined;
    if (
      expected &&
      (expected.version !== runtimeIdentity.version ||
        !sameRuntimePath(expected.appRoot, runtimeIdentity.appRoot))
    )
      throw new Error('DWB_RUNTIME_MISMATCH: this broker belongs to another installation.');
    lifetime.begin();
    await registry.prepareUpgrade();
    setTimeout(() => void shutdown(0), 25).unref();
    return { shuttingDown: true, broker: registry.status };
  }
  if (message.method === 'ping') return { pong: true, broker: registry.status };
  // Local monitoring must not attach a session, allocate a worker or refresh activity.
  if (message.method === 'inspect') {
    const sessions = registry.listSessions();
    return {
      broker: registry.status,
      totalSessions: sessions.length,
      sessions: sessions.slice(0, 200).map((session) => ({
        sessionId: session.sessionId,
        state: session.state,
        workingDirectory: session.workingDirectory,
        workspaceName: workspaceStore.current(session.sessionId)?.name ?? null,
        workerPid: session.workerPid,
        ready: session.workerStatus?.ready ?? false,
        inFlight: session.inFlight,
        queued: session.queued,
        queuePosition: session.queuePosition,
        lastActivityAt: session.lastActivityAt,
        restartCount: session.workerStatus?.restartCount ?? 0,
      })),
    };
  }
  if (!ctx.sessionId) throw new Error('hello must be sent before broker requests');
  const sessionId = await registry.resolveContext(ctx.sessionId, requestContext(message));
  if (message.method === 'list_tools') {
    const upstream = await registry.listTools(sessionId, lifetime);
    return { ...upstream, tools: [...upstream.tools, ...brokerTools] };
  }
  if (message.method === 'call_tool') {
    const params = callParams(message);
    lifetime.check();
    const isControl = brokerTools.some((tool) => tool.name === params.name);
    if (isControl) lifetime.begin();
    const controlled = await controlTool(ctx, sessionId, params.name, params.arguments, message.id);
    if (controlled !== NOT_A_CONTROL_TOOL) {
      if (params.name === 'skills') {
        return (
          await skillPayloadGuard.apply(
            params.name,
            params.arguments,
            controlled as ReturnType<typeof textResult>,
          )
        ).result;
      }
      return controlled;
    }
    return registry.callTool(sessionId, message.id, params, lifetime);
  }
  if (message.method === 'list_resources') return registry.listResources(sessionId, lifetime);
  if (message.method === 'list_resource_templates')
    return registry.listResourceTemplates(sessionId, lifetime);
  if (message.method === 'read_resource') {
    const uri = message.params?.uri;
    if (typeof uri !== 'string' || !uri) throw new Error('read_resource requires uri');
    return registry.readResource(sessionId, uri, lifetime);
  }
  if (message.method === 'shutdown') {
    if (process.env.DWB_BROKER_ALLOW_SHUTDOWN !== 'true')
      throw new Error('Broker shutdown is disabled');
    setTimeout(() => void shutdown(0), 25).unref();
    return { shuttingDown: true };
  }
  throw new Error(`Unsupported broker method: ${message.method}`);
}

function accept(socket: Socket): void {
  sockets.add(socket);
  const ctx: ConnectionContext = {
    sessionId: null,
    adapterPid: null,
    initializing: false,
    closed: false,
    routingChange: null,
  };
  const requests = new Map<string, RequestLifetime>();
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) {
      socket.destroy();
      return;
    }
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: BrokerRequest;
      try {
        message = JSON.parse(line);
      } catch (error) {
        response(socket, errorResponse('invalid-json', error));
        continue;
      }
      if (!message?.id || !message?.method) {
        response(socket, {
          id: message?.id ?? 'invalid-request',
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'id and method are required' },
        });
        continue;
      }
      if (message.method === 'cancel') {
        requests.get(String(message.params?.requestId))?.cancel();
        continue;
      }
      if (requests.has(message.id) || requests.size >= 128) {
        response(
          socket,
          errorResponse(
            message.id,
            new Error('DWB_REQUEST_LIMIT: duplicate ID or too many pending requests'),
          ),
        );
        continue;
      }
      const deadline =
        typeof message.deadline === 'number' && Number.isFinite(message.deadline)
          ? message.deadline
          : Date.now() + 120_000;
      const lifetime = new RequestLifetime(deadline);
      requests.set(message.id, lifetime);
      let replied = false;
      const reply = (value: BrokerResponse) => {
        if (!replied) {
          replied = true;
          response(socket, value);
        }
      };
      lifetime.signal.addEventListener(
        'abort',
        () => reply(errorResponse(message.id, lifetime.error())),
        { once: true },
      );
      const timer = setTimeout(
        () => lifetime.cancel(),
        Math.max(0, Math.min(deadline - Date.now(), 120_000)),
      );
      if (deadline <= Date.now()) lifetime.cancel();
      void handle(ctx, message, lifetime)
        .then((result) =>
          reply({
            id: message.id,
            ok: true,
            result,
            sessionId: ctx.sessionId ?? undefined,
          }),
        )
        .catch((error) => reply(errorResponse(message.id, error)))
        .finally(() => {
          clearTimeout(timer);
          requests.delete(message.id);
        });
    }
  });
  socket.on('close', () => {
    sockets.delete(socket);
    ctx.closed = true;
    for (const request of requests.values()) request.cancel();
    if (ctx.sessionId) void registry.detach(ctx.sessionId).catch(() => {});
  });
  socket.on('error', () => {});
}

const server = createServer(accept);
let shuttingDown = false;
let heartbeat: NodeJS.Timeout | null = null;

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  for (const socket of sockets) socket.destroy();
  await registry?.shutdown().catch(() => {});
  await log
    .write({ type: 'broker_stopped', details: { brokerPid: process.pid, endpoint } })
    .catch(() => {});
  await closed;
  try {
    skillStore?.close();
  } catch {}
  try {
    coreDb?.close();
  } catch {}
  if (process.platform !== 'win32' && unixLease) {
    await unlink(endpoint).catch(() => {});
    unixLease.close();
  }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    if (!process.env.DWB_BROKER_PIPE) {
      const directory = dirname(endpoint);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
        throw new Error('The broker socket directory is not owned by this user.');
      await chmod(directory, 0o700);
    }
    unixLease = acquireUnixBrokerLease(endpoint);
    if (!unixLease) process.exit(0);
    await unlink(endpoint).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
  if (process.platform !== 'win32') await chmod(endpoint, 0o600);
  // Claim the endpoint before opening SQLite: simultaneous cold starts must not
  // race journal/schema initialization or rewrite the live broker's state.
  coreDb = new CoreStore();
  workspaceStore = new WorkspaceStore(coreDb);
  skillStore = new SkillStore();
  registry = new SessionRegistry(log, workspaceStore);
  await registry.restore();
  markReady();
  await log.write({
    type: 'broker_started',
    details: {
      endpoint,
      protocolVersion: BROKER_PROTOCOL_VERSION,
      ...registry.status,
      sessionList: registry.listSessions(),
    },
  });
  heartbeat = setInterval(() => {
    void (async () => {
      await registry.reclaimIdleWorkers();
      await log.write({
        type: 'broker_heartbeat',
        details: { endpoint, ...registry.status, sessionList: registry.listSessions() },
      });
    })().catch(() => {});
  }, 15_000);
  heartbeat.unref();
  console.error(`DWB_BROKER_READY ${endpoint} PID ${process.pid}`);
}

main().catch(async (error: any) => {
  if (error?.code === 'EADDRINUSE') process.exit(0);
  await log
    .write({
      type: 'broker_fatal',
      ok: false,
      details: { brokerPid: process.pid, endpoint, error: String(error) },
    })
    .catch(() => {});
  console.error('[dwb-desktop-broker] fatal:', error);
  process.exit(1);
});
