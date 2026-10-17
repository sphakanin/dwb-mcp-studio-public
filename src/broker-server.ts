import { RequestLifetime } from './request-lifetime.js';
import { acquireUnixBrokerLease } from './unix-broker-lease.js';
import { runtimeIdentity, sameRuntimePath } from './runtime-identity.js';
import { createServer, type Socket } from 'node:net';
import { chmod, lstat, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, basename } from 'node:path';
import {
  brokerEndpoint,
  BROKER_PROTOCOL_VERSION,
  type BrokerLogicalContext,
  type BrokerRequest,
  type BrokerResponse,
} from './broker-protocol.js';
import { brokerTools, textResult, NOT_A_CONTROL_TOOL } from './broker-tools.js';
import { COMPANION_URI, COMPANION_MIME, makeCompanionSnapshot } from './companion-panel.js';
import { randomUUID } from 'node:crypto';
import {
  readBasePolicy,
  planRootChange,
  applyRootPlan,
  type RootOperation,
  type RootPlan,
} from './companion-access.js';
import {
  allowedRoots,
  assertAllowedDirectory,
  projectHomes,
  createStarterProject,
} from './companion-projects.js';
import { EventLog } from './event-log.js';
import { SessionRegistry } from './session-registry.js';
import { CoreStore } from './core-store.js';
import { WorkspaceStore, pathWithin, WORKSPACE_LOCKED_MESSAGE } from './workspace-store.js';
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
type WorkspaceOperation = 'archive' | 'restore' | 'unregister' | 'relink';
type PendingReview = {
  token: string;
  expiresAt: number;
  operation: WorkspaceOperation | RootOperation;
  workspaceId?: string;
  workspaceVersion?: string;
  archivedAt?: string | null;
  path?: string;
  rootPlan?: RootPlan;
};
const pendingReviews = new Map<string, PendingReview>();
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

async function companionSnapshot(sessionId: string, appDetails = false) {
  const roots = await allowedRoots();
  const homes = await projectHomes(roots);
  const workspaces = workspaceStore.list();
  const presentation = workspaceStore.presentationSettings();
  const demoIds = new Set(presentation.demoWorkspaceIds);
  const shown = presentation.enabled ? workspaces.filter((w) => demoIds.has(w.id)) : workspaces;
  const current = workspaceStore.current(sessionId);
  const contextKey = registry.sessionStatus(sessionId).contextKey;
  const selectionLocked = Boolean(current || workspaceStore.contextLock(contextKey));
  const isAllowed = (path: string) =>
    roots.some((root) => {
      try {
        return pathWithin(root, path);
      } catch {
        return false;
      }
    });
  const available = workspaces.filter((w) => !w.archivedAt && isAllowed(w.root));
  const common = makeCompanionSnapshot({
    broker: registry.status,
    current,
    workspaces: shown,
    presentation,
    selectionLocked,
    related: workspaceStore.related(sessionId),
    referenceLimitReached: workspaceStore.related(sessionId).length >= 5,
    projectHomes: homes,
    allowedWorkspaceIds: available.map((w) => w.id),
    skills: skillStore.list(current?.id),
    sessions: registry.listSessions().map((session) => ({
      ...session,
      workspaceName: workspaceStore.current(String(session.sessionId))?.name ?? null,
      workspaceId: workspaceStore.current(String(session.sessionId))?.id ?? null,
    })),
  });
  // The model-visible launch result stays path-redacted. Only app-only tools receive paths.
  if (!appDetails) return common;
  const details = await Promise.all(
    shown.map(async (w) => {
      const exists = (await stat(w.root).catch(() => null))?.isDirectory() === true;
      const status = w.archivedAt
        ? 'archived'
        : !exists
          ? 'missing'
          : isAllowed(w.root)
            ? 'ready'
            : 'outside';
      return {
        id: w.id,
        name: w.name,
        path: presentation.enabled ? '(path masked for recording)' : w.root,
        parent: presentation.enabled ? 'Demo Workspace' : basename(dirname(w.root)),
        status,
        archivedAt: w.archivedAt,
        usage: presentation.enabled ? { bindings: 0, references: 0 } : workspaceStore.usage(w.id),
      };
    }),
  );
  let allowedDirectories: string[] = [];
  let policyError: string | null = null;
  if (!presentation.enabled) {
    try {
      allowedDirectories = (await readBasePolicy()).roots;
    } catch (error) {
      policyError = String(error);
    }
  }
  return {
    ...common,
    currentWorkspace: common.currentWorkspace
      ? {
          ...common.currentWorkspace,
          path: presentation.enabled ? '(path masked for recording)' : current!.root,
        }
      : null,
    workspaces: details,
    allowedDirectories,
    policyError,
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
  if (name === 'dwb_companion' || name === 'dwb_companion_snapshot')
    return textResult(await companionSnapshot(sessionId, name === 'dwb_companion_snapshot'));
  if (name === 'dwb_companion_action') {
    const action = argText(args.action);
    if (action === 'presentation_configure') {
      workspaceStore.configurePresentation(args.demo_workspace_ids);
      return textResult({
        ...(await companionSnapshot(sessionId, true)),
        message: 'Demo Allowlist saved locally in DWB.',
      });
    }
    if (action === 'presentation_exit') {
      workspaceStore.setPresentationEnabled(false);
      return textResult({
        ...(await companionSnapshot(sessionId, true)),
        message: 'Presentation Mode off. All registered projects are visible again.',
      });
    }
    const roots = await allowedRoots();
    if (action === 'presentation_enter') {
      const candidates = workspaceStore.list().filter(
        (workspace) =>
          !workspace.archivedAt &&
          roots.some((root) => {
            try {
              return pathWithin(root, workspace.root);
            } catch {
              return false;
            }
          }),
      );
      const accessibleIds = (
        await Promise.all(
          candidates.map(async (workspace) => ({
            id: workspace.id,
            exists: (await stat(workspace.root).catch(() => null))?.isDirectory() === true,
          })),
        )
      )
        .filter((entry) => entry.exists)
        .map((entry) => entry.id);
      workspaceStore.setPresentationEnabled(true, accessibleIds);
      return textResult({
        ...(await companionSnapshot(sessionId, true)),
        message: 'Presentation Mode on. Only Demo Workspaces are shown.',
      });
    }
    const presentation = workspaceStore.presentationSettings();
    if (presentation.enabled) {
      if (!['switch', 'related_add', 'related_remove'].includes(action))
        throw new Error(
          'Exit Presentation Mode before changing workspace administration settings.',
        );
      if (!presentation.demoWorkspaceIds.includes(argText(args.workspace_id)))
        throw new Error('This workspace is not available in Presentation Mode.');
    }
    if (!roots.length)
      throw new Error('DWB Project Launcher needs a configured allowedDirectories policy.');
    let message = '';
    // Once a chat has chosen a project, do not let project-creation actions
    // write files first and then fail when they try to change its workspace.
    if (
      ['create', 'add_existing'].includes(action) &&
      (workspaceStore.current(sessionId) ||
        workspaceStore.contextLock(registry.sessionStatus(sessionId).contextKey))
    )
      throw new Error(WORKSPACE_LOCKED_MESSAGE);
    if (action === 'review_workspace') {
      const workspaceId = argText(args.workspace_id);
      const workspace = workspaceStore.exact(workspaceId);
      const operation = argText(args.operation) as WorkspaceOperation;
      if (!['archive', 'restore', 'unregister', 'relink'].includes(operation))
        throw new Error('Invalid workspace management action.');
      const usage = workspaceStore.usage(workspace.id);
      if (operation !== 'restore' && (usage.bindings || usage.references))
        throw new Error(
          'Workspace is still used by a session/reference. Remove the binding first.',
        );
      if (operation === 'unregister' && !workspace.archivedAt)
        throw new Error('Archive the workspace before unregistering it.');
      if (operation === 'archive' && workspace.archivedAt)
        throw new Error('Workspace is already archived.');
      if (operation === 'restore' && !workspace.archivedAt)
        throw new Error('Workspace is not archived.');
      const path =
        operation === 'relink'
          ? await assertAllowedDirectory(argText(args.path), roots)
          : undefined;
      const review: PendingReview = {
        token: randomUUID(),
        operation,
        workspaceId,
        workspaceVersion: workspace.updatedAt,
        archivedAt: workspace.archivedAt,
        path,
        expiresAt: Date.now() + 300_000,
      };
      pendingReviews.set(sessionId, review);
      return textResult({
        ...(await companionSnapshot(sessionId, true)),
        review: {
          token: review.token,
          operation,
          title: operation + ' ' + workspace.name,
          description:
            operation === 'unregister'
              ? 'Remove only the DWB registry record; physical files will not be deleted.'
              : operation === 'relink'
                ? 'Keep workspace ID and change its registered path. No files are moved.'
                : 'Only the DWB workspace registry is changed; physical files remain intact.',
          target: workspace.name,
          path: path ?? workspace.root,
          impact: usage,
          expiresInSeconds: 300,
        },
      });
    }
    if (action === 'review_root') {
      const operation = argText(args.operation) as RootOperation;
      if (operation !== 'root_add' && operation !== 'root_remove')
        throw new Error('Invalid allowed directory operation.');
      const plan = await planRootChange(operation, argText(args.path), workspaceStore.list());
      const review: PendingReview = {
        token: randomUUID(),
        operation,
        rootPlan: plan,
        expiresAt: Date.now() + 300_000,
      };
      pendingReviews.set(sessionId, review);
      return textResult({
        ...(await companionSnapshot(sessionId, true)),
        review: {
          token: review.token,
          operation,
          title: operation.replace('_', ' ') + ': ' + plan.path,
          description:
            'This changes the local base policy. Active workers must be stopped first. Restart DWB MCP after applying to load the new policy.',
          target: plan.path,
          path: plan.path,
          impact: { affectedWorkspaces: plan.affected },
          expiresInSeconds: 300,
        },
      });
    }
    if (action === 'apply_review') {
      const pending = pendingReviews.get(sessionId);
      if (
        !pending ||
        pending.token !== argText(args.review_token) ||
        pending.expiresAt < Date.now()
      )
        throw new Error('Review expired or does not match. Preview this change again.');
      pendingReviews.delete(sessionId);
      let message: string;
      if (pending.rootPlan) {
        const brokerStatus = registry.status;
        if (
          brokerStatus.activeWorkers ||
          brokerStatus.startingWorkers ||
          brokerStatus.stoppingWorkers ||
          brokerStatus.inFlightCalls ||
          brokerStatus.queueDepth
        )
          throw new Error(
            'Stop active/starting DWB workers and finish queued requests before editing allowed directories.',
          );
        const occupiedIds = new Set(
          registry.listSessions().flatMap((entry) => {
            const current = workspaceStore.current(String(entry.sessionId));
            return current ? [current.id] : [];
          }),
        );
        if (pending.rootPlan.affected.some((w) => occupiedIds.has(w.id)))
          throw new Error(
            'An affected workspace is still selected by a connected or resumable session.',
          );
        const applied = await applyRootPlan(pending.rootPlan);
        coreDb.run(
          'INSERT INTO companion_policy_events(ts,session_id,action,old_revision,new_revision) VALUES(?,?,?,?,?)',
          [
            new Date().toISOString(),
            sessionId,
            pending.operation,
            applied.previousRevision,
            applied.revision,
          ],
        );
        message = 'Allowed directories saved. Restart DWB MCP so every worker uses the new policy.';
      } else {
        const workspace = workspaceStore.exact(pending.workspaceId!);
        if (
          workspace.updatedAt !== pending.workspaceVersion ||
          workspace.archivedAt !== pending.archivedAt
        )
          throw new Error('Workspace changed since review. Preview again.');
        if (pending.operation === 'archive') workspaceStore.archive(workspace.id, sessionId);
        else if (pending.operation === 'restore') workspaceStore.restore(workspace.id, sessionId);
        else if (pending.operation === 'unregister')
          workspaceStore.unregister(workspace.id, sessionId);
        else if (pending.operation === 'relink')
          await workspaceStore.relink(workspace.id, pending.path!, sessionId);
        message = pending.operation + ' completed for ' + workspace.name + ' (registry only).';
      }
      return textResult({ ...(await companionSnapshot(sessionId, true)), message });
    }
    if (action === 'switch') {
      const workspace = workspaceStore.resolveRef(argText(args.workspace_id));
      await assertAllowedDirectory(workspace.root, roots);
      await registry.workspace(sessionId, { action: 'bind', workspace_id: workspace.id });
      message = 'Workspace selected and locked for this chat: ' + workspace.name;
    } else if (action === 'add_existing') {
      const path = await assertAllowedDirectory(argText(args.path), roots);
      const result = await registry.workspace(sessionId, { action: 'bind', path });
      message =
        'Added and locked ' +
        String((result as any).workspace?.name ?? 'workspace') +
        ' to this chat';
    } else if (action === 'create') {
      const homes = await projectHomes(roots);
      const created = await createStarterProject({
        homeId: argText(args.home_id),
        projectName: args.project_name,
        kind: argText(args.project_kind),
        homes,
      });
      // Retain the created folder even if an active worker prevents binding it.
      const result = await registry
        .workspace(sessionId, {
          action: 'bind',
          path: created.directory,
        })
        .catch(async (error) => {
          await workspaceStore.register({ path: created.directory }, sessionId);
          return { warning: String(error) };
        });
      message =
        'Created ' +
        created.name +
        ((result as any).warning
          ? ' — saved, but workspace switch was blocked: ' + (result as any).warning
          : ' and activated');
    } else if (action === 'related_add') {
      const target = workspaceStore.resolveRef(argText(args.workspace_id));
      await assertAllowedDirectory(target.root, roots);
      workspaceStore.addRelated(sessionId, target.id);
      message = 'Added read-only reference: ' + target.name;
    } else if (action === 'related_remove') {
      workspaceStore.removeRelated(sessionId, argText(args.workspace_id));
      message = 'Reference removed';
    } else {
      throw new Error('Unsupported DWB Companion action.');
    }
    return textResult({ ...(await companionSnapshot(sessionId, true)), message });
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
  if (message.method === 'list_resources') {
    const upstream = await registry.listResources(sessionId, lifetime);
    return {
      ...upstream,
      resources: [
        ...(upstream.resources ?? []),
        {
          uri: COMPANION_URI,
          name: 'DWB Companion',
          description: 'Read-only ChatGPT conversation panel for DWB MCP Studio',
          mimeType: COMPANION_MIME,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    };
  }
  if (message.method === 'list_resource_templates')
    return registry.listResourceTemplates(sessionId, lifetime);
  if (message.method === 'read_resource') {
    const uri = message.params?.uri;
    if (typeof uri !== 'string' || !uri) throw new Error('read_resource requires uri');
    if (uri === COMPANION_URI) {
      const html = await readFile(new URL('./companion-panel.html', import.meta.url), 'utf8');
      return {
        contents: [
          {
            uri: COMPANION_URI,
            mimeType: COMPANION_MIME,
            text: html,
            _meta: { ui: { prefersBorder: true } },
          },
        ],
      };
    }
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
