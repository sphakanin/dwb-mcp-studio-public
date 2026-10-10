import { runtimeIdentity } from './runtime-identity.js';
import { RequestLifetime } from './request-lifetime.js';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { BrokerLogicalContext } from './broker-protocol.js';
import { loadBrokerState, saveBrokerState, type PersistedSession } from './broker-state.js';
import { EventLog } from './event-log.js';
import {
  canonicalPath,
  fingerprint,
  planTool,
  sameFingerprint,
  StaleFileConflictError,
  physicalPath,
  type FileFingerprint,
} from './file-observer.js';
import { LockManager } from './lock-manager.js';
import { WorkerSupervisor, type WorkerContext } from './worker-supervisor.js';
import { WorkspaceStore, WORKSPACE_LOCKED_MESSAGE, type WorkspaceView } from './workspace-store.js';

type SessionState = 'attached' | 'detached';
type WorkerAllocation = { worker: WorkerSupervisor; queueMs: number };

type Session = {
  id: string;
  workspaceKey: string;
  transportWorkspaceKey: string;
  contextKey: string | null;
  contextSource: string | null;
  contextPreview: string | null;
  transportSessionId: string;
  adapterPid: number | null;
  state: SessionState;
  worker: WorkerSupervisor | null;
  workerId: string | null;
  allocationPromise: Promise<WorkerAllocation> | null;
  retirement: Promise<void> | null;
  restarting: boolean;
  changingWorkspace: boolean;
  observations: Map<string, FileFingerprint>;
  createdAt: string;
  lastActivityAt: string;
  detachedAt: string | null;
  inFlight: number;
  queuedAt: number | null;
  cleanupTimer: NodeJS.Timeout | null;
};

type QueueItem = {
  sessionId: string;
  queuedAt: number;
  resolve: (queueMs: number) => void;
  reject: (error: Error) => void;
};

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export class SessionRegistry {
  readonly locks = new LockManager();
  private readonly sessions = new Map<string, Session>();
  private readonly queue: QueueItem[] = [];
  private startingWorkers = 0;
  private stoppingWorkers = 0;
  private shuttingDown = false;
  private quiescing = false;
  private readonly workerCap = Math.max(1, envInt('DWB_WORKER_CAP', 4));
  private readonly detachGraceMs = envInt('DWB_DETACH_GRACE_MS', 5 * 60_000);
  private readonly idleWorkerMs = Math.max(250, envInt('DWB_IDLE_WORKER_MS', 60_000));
  private readonly restoreMaxAgeMs = Math.max(
    this.detachGraceMs,
    envInt('DWB_BROKER_RESTORE_MAX_AGE_MS', 30 * 60_000),
  );
  private stateWriteChain: Promise<void> = Promise.resolve();
  private persistenceError: string | null = null;
  private idleReclaim: Promise<number> | null = null;

  constructor(
    private readonly log: EventLog,
    private readonly workspaceStore?: WorkspaceStore,
    private readonly createWorker = (log: EventLog, context: WorkerContext) =>
      new WorkerSupervisor(log, context),
  ) {}

  get status() {
    const all = [...this.sessions.values()];
    return {
      persistence: { healthy: this.persistenceError === null, error: this.persistenceError },
      runtime: runtimeIdentity,
      brokerPid: process.pid,
      workerCap: this.workerCap,
      sessions: all.length,
      attachedSessions: all.filter((s) => s.state === 'attached').length,
      detachedSessions: all.filter((s) => s.state === 'detached').length,
      activeWorkers: all.filter((s) => s.worker).length,
      startingWorkers: this.startingWorkers,
      stoppingWorkers: this.stoppingWorkers,
      queueDepth: this.queue.length,
      inFlightCalls: all.reduce((sum, s) => sum + s.inFlight, 0),
      locks: this.locks.status,
    };
  }

  private require(id: string): Session {
    if (this.shuttingDown || this.quiescing)
      throw new Error('Broker shutting down or preparing an upgrade');
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown MCP session: ${id}`);
    return session;
  }

  private view(session: Session) {
    return {
      sessionId: session.id,
      persistence: { healthy: this.persistenceError === null, error: this.persistenceError },
      state: session.state,
      workspaceKey: session.workspaceKey,
      transportWorkspaceKey: session.transportWorkspaceKey,
      workingDirectory: this.workingDirectory(session),
      contextKey: session.contextKey,
      contextSource: session.contextSource,
      contextPreview: session.contextPreview,
      transportSessionId: session.transportSessionId,
      adapterPid: session.adapterPid,
      workerId: session.workerId,
      workerPid: session.worker?.status.workerPid ?? null,
      workerStatus: session.worker?.status ?? null,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      detachedAt: session.detachedAt,
      inFlight: session.inFlight,
      queued: session.queuedAt !== null,
      queuePosition: this.queue.findIndex((item) => item.sessionId === session.id) + 1 || null,
      queueWaitMs: session.queuedAt === null ? 0 : Math.round(performance.now() - session.queuedAt),
      observations: session.observations.size,
    };
  }

  listSessions() {
    return [...this.sessions.values()].map((s) => this.view(s));
  }
  listDetached() {
    return [...this.sessions.values()]
      .filter((s) => s.state === 'detached')
      .map((s) => this.view(s));
  }
  sessionStatus(id: string) {
    return this.view(this.require(id));
  }

  private persistedSessions(): PersistedSession[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      workspaceKey: session.workspaceKey,
      transportWorkspaceKey: session.transportWorkspaceKey,
      contextKey: session.contextKey,
      contextSource: session.contextSource,
      contextPreview: session.contextPreview,
      transportSessionId: session.transportSessionId,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      detachedAt: session.detachedAt,
      observations: [...session.observations.entries()],
    }));
  }

  private persistState(): Promise<void> {
    const snapshot = this.persistedSessions();
    this.stateWriteChain = this.stateWriteChain
      .then(async () => {
        await saveBrokerState(snapshot);
        this.persistenceError = null;
      })
      .catch(async (error) => {
        this.persistenceError =
          'DWB_STATE_SAVE_FAILED: session continuity is not saved. Check the data folder and free disk space.';
        await this.log
          .write({
            type: 'broker_state_save_failed',
            ok: false,
            details: { error: this.persistenceError, code: (error as any)?.code ?? 'UNKNOWN' },
          })
          .catch(() => {});
      });
    return this.stateWriteChain;
  }

  async restore(): Promise<number> {
    const state = await loadBrokerState();
    const cutoff = Date.now() - this.restoreMaxAgeMs;
    let restored = 0;
    for (const saved of state.sessions) {
      if (!saved?.id || !saved.workspaceKey || Date.parse(saved.lastActivityAt) < cutoff) continue;
      if (this.sessions.has(saved.id)) continue;
      const now = new Date().toISOString();
      const session: Session = {
        id: saved.id,
        workspaceKey: saved.workspaceKey,
        transportWorkspaceKey: saved.transportWorkspaceKey ?? saved.workspaceKey,
        contextKey: saved.contextKey ?? null,
        contextSource: saved.contextSource ?? null,
        contextPreview: saved.contextPreview ?? null,
        transportSessionId: saved.transportSessionId || saved.id,
        adapterPid: null,
        state: 'detached',
        worker: null,
        workerId: null,
        allocationPromise: null,
        retirement: null,
        restarting: false,
        changingWorkspace: false,
        observations: new Map(
          (saved.observations ?? []).flatMap(([path, value]): Array<[string, FileFingerprint]> => {
            try {
              return [[canonicalPath(path, saved.workspaceKey) ?? path, value]];
            } catch {
              return [];
            } // An offline drive must not discard other saved sessions.
          }),
        ),
        createdAt: saved.createdAt || now,
        lastActivityAt: saved.lastActivityAt || now,
        detachedAt: saved.detachedAt || now,
        inFlight: 0,
        queuedAt: null,
        cleanupTimer: null,
      };
      this.sessions.set(session.id, session);
      this.scheduleCleanup(session);
      restored += 1;
    }
    if (restored) await this.log.write({ type: 'broker_state_restored', details: { restored } });
    await this.persistState();
    return restored;
  }

  async attach(
    workspaceKey: string,
    adapterPid: number | null,
    preferredId?: string | null,
  ): Promise<string> {
    if (this.shuttingDown) throw new Error('Broker shutting down');
    if (preferredId) {
      const restored = this.sessions.get(preferredId);
      if (
        restored &&
        restored.state === 'detached' &&
        restored.transportWorkspaceKey === workspaceKey
      ) {
        if (restored.cleanupTimer) clearTimeout(restored.cleanupTimer);
        restored.cleanupTimer = null;
        restored.state = 'attached';
        restored.adapterPid = adapterPid;
        restored.detachedAt = null;
        restored.lastActivityAt = new Date().toISOString();
        await this.log.write({
          type: 'session_recovered_after_broker_restart',
          sessionId: restored.id,
          workspaceKey: restored.workspaceKey,
          details: { adapterPid, brokerPid: process.pid },
        });
        await this.persistState();
        return restored.id;
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.sessions.set(id, {
      id,
      workspaceKey,
      transportWorkspaceKey: workspaceKey,
      contextKey: null,
      contextSource: null,
      contextPreview: null,
      transportSessionId: id,
      adapterPid,
      state: 'attached',
      worker: null,
      workerId: null,
      allocationPromise: null,
      retirement: null,
      restarting: false,
      changingWorkspace: false,
      observations: new Map(),
      createdAt: now,
      lastActivityAt: now,
      detachedAt: null,
      inFlight: 0,
      queuedAt: null,
      cleanupTimer: null,
    });
    await this.log.write({
      type: 'session_attached',
      sessionId: id,
      workspaceKey,
      details: { adapterPid, brokerPid: process.pid },
    });
    await this.persistState();
    return id;
  }

  private async restoreConversationSelection(session: Session): Promise<void> {
    const store = this.workspaceStore;
    if (!store || !session.contextKey) return;
    const selected = store.current(session.id);
    const lockedId = store.contextLock(session.contextKey);
    if (selected && lockedId && selected.id !== lockedId) throw new Error(WORKSPACE_LOCKED_MESSAGE);
    if (selected && !lockedId) {
      // Upgrade an existing binding to a durable conversation lock.
      store.bindKnown(session.id, selected, session.contextKey);
      return;
    }
    if (!lockedId || selected) return;
    // The original session may have been cleaned up. Preserve the previous selection
    // when this chat reconnects, but never switch to a different project.
    const previous = store.list().find((item) => item.id === lockedId);
    if (!previous || previous.archivedAt) return;
    if (!(await stat(previous.root).catch(() => null))?.isDirectory()) return;
    store.bindKnown(session.id, previous, session.contextKey);
  }

  private matchesSelectedWorkspace(
    args: Record<string, unknown>,
    workspace: WorkspaceView,
  ): boolean {
    const ref = [args.path, args.workspace, args.workspace_id, args.name]
      .find((item): item is string => typeof item === 'string' && !!item.trim())
      ?.trim();
    if (!ref) return false;
    if (isAbsolute(ref)) {
      try {
        return physicalPath(ref) === physicalPath(workspace.root);
      } catch {
        return false;
      }
    }
    try {
      return this.workspaceStore?.resolveRef(ref).id === workspace.id;
    } catch {
      return false;
    }
  }

  async resolveContext(rootId: string, context?: BrokerLogicalContext | null): Promise<string> {
    const root = this.require(rootId);
    if (!context?.key) return root.id;
    const transportSessionId = root.transportSessionId || root.id;
    let existing = [...this.sessions.values()].find(
      (session) =>
        session.transportSessionId === transportSessionId && session.contextKey === context.key,
    );
    if (!existing) {
      existing = [...this.sessions.values()].find(
        (session) =>
          session.id !== root.id &&
          session.state === 'detached' &&
          session.transportWorkspaceKey === root.transportWorkspaceKey &&
          session.contextKey === context.key,
      );
    }
    if (existing) {
      if (existing.cleanupTimer) clearTimeout(existing.cleanupTimer);
      existing.cleanupTimer = null;
      existing.state = 'attached';
      existing.transportSessionId = transportSessionId;
      existing.adapterPid = root.adapterPid;
      existing.detachedAt = null;
      existing.lastActivityAt = new Date().toISOString();
      existing.contextSource = context.source;
      existing.contextPreview = context.preview ?? existing.contextPreview;
      await this.restoreConversationSelection(existing);
      await this.log.write({
        type: 'logical_context_recovered',
        sessionId: existing.id,
        workspaceKey: existing.workspaceKey,
        details: {
          transportSessionId,
          contextSource: existing.contextSource,
          contextPreview: existing.contextPreview,
        },
      });
      await this.persistState();
      return existing.id;
    }
    if (!root.contextKey) {
      root.contextKey = context.key;
      root.contextSource = context.source;
      root.contextPreview = context.preview ?? null;
      root.lastActivityAt = new Date().toISOString();
      await this.restoreConversationSelection(root);
      await this.log.write({
        type: 'logical_context_bound',
        sessionId: root.id,
        workspaceKey: root.workspaceKey,
        details: {
          transportSessionId,
          contextSource: root.contextSource,
          contextPreview: root.contextPreview,
        },
      });
      await this.persistState();
      return root.id;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.sessions.set(id, {
      id,
      workspaceKey: root.transportWorkspaceKey,
      transportWorkspaceKey: root.transportWorkspaceKey,
      contextKey: context.key,
      contextSource: context.source,
      contextPreview: context.preview ?? null,
      transportSessionId,
      adapterPid: root.adapterPid,
      state: 'attached',
      worker: null,
      workerId: null,
      allocationPromise: null,
      retirement: null,
      restarting: false,
      changingWorkspace: false,
      observations: new Map(),
      createdAt: now,
      lastActivityAt: now,
      detachedAt: null,
      inFlight: 0,
      queuedAt: null,
      cleanupTimer: null,
    });
    await this.restoreConversationSelection(this.sessions.get(id)!);
    await this.log.write({
      type: 'logical_context_attached',
      sessionId: id,
      workspaceKey: root.workspaceKey,
      details: {
        transportSessionId,
        contextSource: context.source,
        contextPreview: context.preview ?? null,
      },
    });
    await this.persistState();
    return id;
  }

  async detach(id: string): Promise<void> {
    const root = this.sessions.get(id);
    if (!root) return;
    const transportSessionId = root.transportSessionId || root.id;
    const family = [...this.sessions.values()].filter(
      (session) =>
        session.transportSessionId === transportSessionId && session.state !== 'detached',
    );
    if (!family.length) return;
    const now = new Date().toISOString();
    for (const session of family) {
      session.state = 'detached';
      session.adapterPid = null;
      session.detachedAt = now;
      session.lastActivityAt = now;
      for (let i = this.queue.length - 1; i >= 0; i -= 1) {
        if (this.queue[i].sessionId !== session.id) continue;
        const [item] = this.queue.splice(i, 1);
        item.reject(new Error('MCP session detached while waiting for a worker'));
      }
      session.queuedAt = null;
      await this.log.write({
        type: 'session_detached',
        sessionId: session.id,
        workerId: session.workerId ?? undefined,
        workspaceKey: session.workspaceKey,
        workerPid: session.worker?.status.workerPid ?? null,
        details: { transportSessionId },
      });
      this.scheduleCleanup(session);
    }
    await this.persistState();
    void this.reclaimForQueue().catch(() => {});
  }

  private scheduleCleanup(session: Session): void {
    if (
      this.shuttingDown ||
      this.sessions.get(session.id) !== session ||
      session.state !== 'detached'
    )
      return;
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(
      () => void this.cleanupDetached(session.id).catch(() => this.scheduleCleanup(session)),
      this.detachGraceMs,
    );
    session.cleanupTimer.unref();
  }

  private async cleanupDetached(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.state !== 'detached') return;
    if (session.inFlight > 0 || session.allocationPromise || session.retirement) {
      this.scheduleCleanup(session);
      return;
    }
    const worker = session.worker;
    const active = worker && (await worker.hasActiveWork().catch(() => true));
    // A reconnect or request may have arrived while the upstream probe was running.
    if (
      this.shuttingDown ||
      session.state !== 'detached' ||
      session.inFlight ||
      session.allocationPromise ||
      session.retirement ||
      session.worker !== worker
    )
      return;
    if (active) {
      await this.log.write({
        type: 'detached_session_retained',
        sessionId: id,
        workerId: session.workerId ?? undefined,
        workspaceKey: session.workspaceKey,
        workerPid: worker.status.workerPid,
        reason: 'active_work',
      });
      this.scheduleCleanup(session);
      return;
    }
    await this.destroySession(session, 'detach_grace_expired');
  }

  private async destroySession(session: Session, reason: string): Promise<void> {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
    this.sessions.delete(session.id);
    if (session.worker) await this.retireWorker(session);
    this.workspaceStore?.releaseExpiredSession(session.id);
    await this.log
      .write({
        type: 'session_destroyed',
        sessionId: session.id,
        workspaceKey: session.workspaceKey,
        reason,
      })
      .catch(() => {});
    await this.persistState();
    this.grantQueued();
  }

  private workerUsage(): number {
    let count = this.startingWorkers + this.stoppingWorkers;
    for (const session of this.sessions.values()) if (session.worker) count += 1;
    return count;
  }

  private workingDirectory(session: Session): string {
    return this.workspaceStore?.current(session.id)?.root ?? session.workspaceKey;
  }

  async workspace(id: string, args: Record<string, unknown>) {
    const session = this.require(id);
    const store = this.workspaceStore;
    if (!store) throw new Error('Workspace storage is unavailable');
    const action = String(args.action ?? '').trim();
    if (action !== 'bind' && action !== 'unbind') return store.handle(args, id);
    this.assertAttached(session);
    const selected = store.current(id);
    const persistentLockId = store.contextLock(session.contextKey);
    if (persistentLockId && selected && persistentLockId !== selected.id)
      throw new Error(WORKSPACE_LOCKED_MESSAGE);
    const lockedId = persistentLockId ?? selected?.id ?? null;
    if (action === 'unbind' && lockedId) throw new Error(WORKSPACE_LOCKED_MESSAGE);
    if (action === 'bind' && lockedId) {
      const lockedWorkspace = store.list().find((item) => item.id === lockedId);
      if (!lockedWorkspace || !this.matchesSelectedWorkspace(args, lockedWorkspace))
        throw new Error(WORKSPACE_LOCKED_MESSAGE);
      if (selected) {
        // Idempotent bind of the SAME project is safe, even with a running worker.
        if (session.contextKey && !persistentLockId)
          store.bindKnown(id, selected, session.contextKey);
        return {
          workspace: selected,
          workingDirectory: selected.root,
          workerReady: !!session.worker,
          persistence: this.status.persistence,
          locked: true,
        };
      }
      if (lockedWorkspace.archivedAt) throw new Error(WORKSPACE_LOCKED_MESSAGE);
    }
    if (
      session.inFlight ||
      session.allocationPromise ||
      session.retirement ||
      session.changingWorkspace
    )
      throw new Error('Session is busy; wait for current requests before selecting a workspace');
    session.changingWorkspace = true;
    session.inFlight++;
    try {
      // Resolve a pre-existing conversation lock by ID, never register a different path.
      const workspace =
        action === 'bind'
          ? await store.resolveBinding(lockedId ? { workspace_id: lockedId } : args, id)
          : null;
      const directory = workspace?.root ?? session.workspaceKey;
      this.assertAttached(session);
      if (directory !== this.workingDirectory(session) && session.worker) {
        if (await session.worker.hasActiveWork().catch(() => true))
          throw new Error(
            'Worker has active processes or searches; finish them before selecting a workspace',
          );
        this.assertAttached(session);
        await this.retireWorker(session);
        this.assertAttached(session);
      }
      const result = workspace
        ? { workspace: store.bindKnown(id, workspace, session.contextKey) }
        : store.unbind(id);
      await this.persistState();
      return {
        ...result,
        workingDirectory: directory,
        workerReady: !!session.worker,
        persistence: this.status.persistence,
        locked: Boolean(workspace),
      };
    } finally {
      session.changingWorkspace = false;
      session.inFlight--;
      session.lastActivityAt = new Date().toISOString();
    }
  }

  private async spawnWorker(session: Session, queueMs: number): Promise<void> {
    const workerId = randomUUID();
    let worker: WorkerSupervisor | null = null;
    try {
      worker = this.createWorker(this.log, {
        sessionId: session.id,
        workspaceKey: this.workingDirectory(session),
        workerId,
      });
      await worker.start();
      this.assertAttached(session);
      session.worker = worker;
      session.workerId = workerId;
      session.queuedAt = null;
      void this.log
        .write({
          type: 'session_worker_assigned',
          sessionId: session.id,
          workerId,
          workspaceKey: session.workspaceKey,
          workerPid: worker.status.workerPid,
          queueMs,
        })
        .catch(() => {});
    } catch (error) {
      await worker?.stop().catch(() => {});
      throw error;
    } finally {
      this.startingWorkers -= 1;
      this.grantQueued();
    }
  }

  private assertAttached(session: Session): void {
    if (this.shuttingDown) throw new Error('Broker shutting down');
    if (this.sessions.get(session.id) !== session || session.state !== 'attached')
      throw new Error('MCP session detached while waiting for a worker');
  }

  private retireWorker(session: Session): Promise<void> {
    if (session.retirement) return session.retirement;
    const worker = session.worker;
    if (!worker) return Promise.resolve();
    // Remove it from circulation synchronously, but count its process until stop completes.
    session.worker = null;
    session.workerId = null;
    this.stoppingWorkers++;
    session.retirement = worker
      .stop()
      .catch(() => {})
      .finally(() => {
        this.stoppingWorkers--;
        session.retirement = null;
        this.grantQueued();
      });
    return session.retirement;
  }

  async reclaimIdleWorkers(limit = Number.POSITIVE_INFINITY): Promise<number> {
    if (this.shuttingDown) return 0;
    if (this.idleReclaim) return this.idleReclaim;
    this.idleReclaim = (async () => {
      const cutoff = Date.now() - this.idleWorkerMs;
      let reclaimed = 0;
      const eligible = (session: Session) =>
        !this.shuttingDown &&
        this.sessions.get(session.id) === session &&
        !!session.worker &&
        !session.inFlight &&
        !session.allocationPromise &&
        !session.retirement &&
        (session.state === 'detached' || Date.parse(session.lastActivityAt) <= cutoff);
      const candidates = [...this.sessions.values()]
        .filter(eligible)
        .sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt));
      for (const session of candidates) {
        if (!eligible(session)) continue;
        const worker = session.worker!;
        const activity = session.lastActivityAt;
        const state = session.state;
        const active = await worker.hasActiveWork().catch(() => true);
        if (
          active ||
          !eligible(session) ||
          session.worker !== worker ||
          session.lastActivityAt !== activity ||
          session.state !== state
        )
          continue;
        const workerId = session.workerId;
        const workerPid = session.worker!.status.workerPid;
        await this.retireWorker(session);
        reclaimed += 1;
        await this.log
          .write({
            type: state === 'detached' ? 'detached_worker_reclaimed' : 'idle_worker_reclaimed',
            sessionId: session.id,
            workerId: workerId ?? undefined,
            workspaceKey: session.workspaceKey,
            workerPid,
            reason: 'idle_context',
            details: { idleWorkerMs: this.idleWorkerMs },
          })
          .catch(() => {});
        if (reclaimed >= limit) break;
      }
      if (reclaimed) this.grantQueued();
      return reclaimed;
    })().finally(() => {
      this.idleReclaim = null;
    });
    return this.idleReclaim;
  }

  private async waitForWorker(session: Session): Promise<number> {
    this.assertAttached(session);
    const queuedAt = performance.now();
    session.queuedAt = queuedAt;
    void this.log
      .write({
        type: 'worker_queued',
        sessionId: session.id,
        workspaceKey: session.workspaceKey,
        details: { queueDepth: this.queue.length + 1, workerCap: this.workerCap },
      })
      .catch(() => {});
    return new Promise<number>((resolve, reject) => {
      this.queue.push({
        sessionId: session.id,
        queuedAt,
        resolve,
        reject,
      });
      this.grantQueued();
      void this.reclaimForQueue().catch(() => {});
    });
  }

  private grantQueued(): void {
    if (this.shuttingDown) return;
    while (this.queue.length && this.workerUsage() < this.workerCap) {
      const item = this.queue.shift()!;
      const session = this.sessions.get(item.sessionId);
      // The item is already off the queue, so every path out of this iteration
      // must settle it. Dropping it would leave allocateWorker awaiting a
      // promise that can never resolve, hanging the request until it times out.
      if (!session) {
        item.reject(new Error('MCP session was destroyed while waiting for a worker'));
        continue;
      }
      if (session.state !== 'attached') {
        item.reject(new Error('MCP session detached while waiting for a worker'));
        continue;
      }
      session.queuedAt = null;
      this.startingWorkers += 1; // reserve capacity before waking the waiter
      const queueMs = Math.round(performance.now() - item.queuedAt);
      item.resolve(queueMs);
    }
  }

  private async reclaimForQueue(): Promise<void> {
    if (!this.queue.length || this.workerUsage() < this.workerCap) {
      this.grantQueued();
      return;
    }
    // Reclaim only enough capacity for the waiting requests; keep other warm workers.
    await this.reclaimIdleWorkers(this.queue.length);
    this.grantQueued();
  }

  private async allocateWorker(session: Session): Promise<WorkerAllocation> {
    if (session.retirement) await session.retirement;
    if (!session.inFlight) throw new Error('No requests remain for this worker allocation');
    const queueMs = await this.waitForWorker(session);
    try {
      this.assertAttached(session);
    } catch (error) {
      this.startingWorkers -= 1;
      this.grantQueued();
      throw error;
    }
    await this.spawnWorker(session, queueMs);
    return { worker: session.worker!, queueMs };
  }

  private ensureWorker(session: Session): Promise<WorkerAllocation> {
    this.assertAttached(session);
    if (session.worker) return Promise.resolve({ worker: session.worker, queueMs: 0 });
    if (session.allocationPromise) return session.allocationPromise;
    session.allocationPromise = this.allocateWorker(session).finally(() => {
      session.allocationPromise = null;
    });
    return session.allocationPromise;
  }

  private cancelEmptyAllocation(session: Session, lifetime: RequestLifetime): void {
    if (session.inFlight) return;
    const index = this.queue.findIndex((item) => item.sessionId === session.id);
    if (index < 0) return;
    const [item] = this.queue.splice(index, 1);
    session.queuedAt = null;
    item.reject(lifetime.error());
  }

  private async withWorker<T>(
    id: string,
    action: (worker: WorkerSupervisor) => Promise<T>,
    lifetime = new RequestLifetime(),
  ): Promise<T> {
    lifetime.check();
    const session = this.require(id);
    if (session.changingWorkspace)
      throw new Error('Workspace is changing; retry when binding finishes');
    if (session.restarting) throw new Error('Worker is restarting; retry after it is ready');
    session.lastActivityAt = new Date().toISOString();
    session.inFlight++;
    try {
      const { worker } = await lifetime.wait(this.ensureWorker(session));
      lifetime.begin();
      return await action(worker);
    } finally {
      session.inFlight--;
      this.cancelEmptyAllocation(session, lifetime);
      session.lastActivityAt = new Date().toISOString();
      void this.reclaimForQueue().catch(() => {});
    }
  }

  async listTools(id: string, lifetime?: RequestLifetime) {
    return this.withWorker(id, (worker) => worker.listTools(), lifetime);
  }

  async listResources(id: string, lifetime?: RequestLifetime) {
    return this.withWorker(id, (worker) => worker.listResources(), lifetime);
  }

  async listResourceTemplates(id: string, lifetime?: RequestLifetime) {
    return this.withWorker(id, (worker) => worker.listResourceTemplates(), lifetime);
  }

  async readResource(id: string, uri: string, lifetime?: RequestLifetime) {
    return this.withWorker(id, (worker) => worker.readResource(uri), lifetime);
  }

  async restartWorker(id: string): Promise<unknown> {
    const session = this.require(id);
    if (session.inFlight || session.allocationPromise || session.restarting)
      throw new Error('Worker is busy; wait for current requests before restarting');
    session.restarting = true;
    session.inFlight++;
    try {
      const { worker } = await this.ensureWorker(session);
      if (await worker.hasActiveWork().catch(() => true))
        throw new Error('Worker has active processes or searches; finish them before restarting');
      this.assertAttached(session);
      await worker.restart('manual_tool');
    } finally {
      session.restarting = false;
      session.inFlight--;
      session.lastActivityAt = new Date().toISOString();
    }
    return this.sessionStatus(id);
  }

  private async assertFresh(session: Session, paths: string[]): Promise<void> {
    for (const path of paths) {
      const expected = session.observations.get(path);
      if (!expected) continue;
      const current = await fingerprint(path);
      if (!sameFingerprint(expected, current))
        throw new StaleFileConflictError(path, expected, current);
    }
  }

  private async refreshObservations(session: Session, paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        session.observations.set(path, await fingerprint(path));
      } catch {
        session.observations.delete(path);
      }
    }
    await this.persistState();
  }

  private conflictResult(error: StaleFileConflictError) {
    const short = (fp: FileFingerprint) =>
      fp.sha256?.slice(0, 12) ??
      `${fp.exists ? 'exists' : 'missing'}:${fp.size}:${Math.round(fp.mtimeMs)}`;
    const text = [
      'DWB stale-write protection blocked this mutation.',
      '',
      `File: ${error.path}`,
      `Expected version: ${short(error.expected)}`,
      `Current version:  ${short(error.current)}`,
      '',
      'Another MCP session changed this file after this session last read it.',
      'Re-read the file, reconcile the newer content, then retry the edit.',
    ].join('\n');
    return { content: [{ type: 'text', text }], isError: true };
  }

  async callTool(
    id: string,
    requestId: string,
    params: CallToolRequest['params'],
    lifetime = new RequestLifetime(),
  ) {
    lifetime.check();
    const session = this.require(id);
    if (session.changingWorkspace)
      throw new Error('Workspace is changing; retry when binding finishes');
    if (session.restarting) throw new Error('Worker is restarting; retry after it is ready');
    session.lastActivityAt = new Date().toISOString();
    session.inFlight += 1;
    let lease: Awaited<ReturnType<LockManager['acquire']>> | null = null;
    let queueMs = 0;
    try {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const plan = planTool(params.name, args, this.workingDirectory(session));
      const mutationPaths = [
        ...plan.mutate,
        ...plan.locks.filter((x) => x.startsWith('file:')).map((x) => x.slice(5)),
      ];
      const gate = this.workspaceStore?.mutationGate({
        sessionId: id,
        kind: plan.kind,
        paths: mutationPaths,
      });
      if (gate && gate.allowed === false) {
        await this.log.write({
          type: 'workspace_mutation_blocked',
          sessionId: id,
          tool: params.name,
          ok: false,
          workspaceKey: session.workspaceKey,
          details: gate,
        });
        return { content: [{ type: 'text', text: gate.message }], isError: true };
      }
      const allocation = await lifetime.wait(this.ensureWorker(session));
      queueMs = allocation.queueMs;
      const mode = plan.kind === 'read' ? 'read' : 'write';
      lease = await this.locks.acquire(plan.locks, `${id}:${requestId}`, mode, lifetime.signal);
      // A queued call may have waited while a directory junction changed.
      const currentPlan = planTool(params.name, args, this.workingDirectory(session));
      if (JSON.stringify(currentPlan) !== JSON.stringify(plan))
        throw new Error(
          'DWB_PATH_CHANGED: path changed while waiting; inspect the path before retrying',
        );
      const currentGate = this.workspaceStore?.mutationGate({
        sessionId: id,
        kind: plan.kind,
        paths: mutationPaths,
      });
      if (currentGate && !currentGate.allowed)
        return { content: [{ type: 'text', text: currentGate.message }], isError: true };
      if (plan.mutate.length) await this.assertFresh(session, plan.mutate);
      lifetime.begin();
      const result = await allocation.worker.callTool(params, {
        requestId,
        queueMs,
        lockWaitMs: lease.waitMs,
      });
      if (!(result as any)?.isError) {
        await this.refreshObservations(session, [...plan.observe, ...plan.mutate]);
      }
      if (this.persistenceError && Array.isArray((result as any).content)) {
        (result as any).content.push({
          type: 'text',
          text:
            this.persistenceError +
            ' The tool result above is valid; do not repeat a completed mutation.',
        });
      }
      return result;
    } catch (error) {
      if (error instanceof StaleFileConflictError) {
        this.locks.markConflict();
        const result = this.conflictResult(error);
        const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
        await this.log.write({
          type: 'tool_call',
          tool: params.name,
          ok: false,
          bytes,
          sessionId: id,
          requestId,
          workerId: session.workerId ?? undefined,
          workspaceKey: session.workspaceKey,
          workerPid: session.worker?.status.workerPid ?? null,
          queueMs,
          lockWaitMs: lease?.waitMs ?? 0,
          conflict: true,
          details: {
            forwardedBytes: bytes,
            guarded: false,
            conflictPath: error.path,
            expected: error.expected,
            current: error.current,
          },
        });
        return result;
      }
      throw error;
    } finally {
      lease?.release();
      session.inFlight = Math.max(0, session.inFlight - 1);
      this.cancelEmptyAllocation(session, lifetime);
      session.lastActivityAt = new Date().toISOString();
      void this.reclaimForQueue().catch(() => {});
    }
  }

  async resume(currentId: string, targetId: string, adapterPid: number | null): Promise<string> {
    if (currentId === targetId) return currentId;
    const current = this.require(currentId);
    const target = this.require(targetId);
    if (
      this.workspaceStore?.current(currentId) ||
      this.workspaceStore?.contextLock(current.contextKey)
    )
      throw new Error(WORKSPACE_LOCKED_MESSAGE);
    if (target.state !== 'detached') throw new Error('Target session is not detached');
    if (target.inFlight || target.allocationPromise || target.retirement)
      throw new Error('Target session is busy; retry when its requests finish');
    if (current.inFlight || current.allocationPromise || current.retirement)
      throw new Error('Current session is busy; retry when its requests finish');
    current.inFlight++;
    target.inFlight++;
    current.changingWorkspace = true;
    target.changingWorkspace = true;
    try {
      if (current.worker && (await current.worker.hasActiveWork().catch(() => true)))
        throw new Error(
          'Current worker has active processes or searches; finish them before resuming another session',
        );
      this.assertAttached(current);
      if (target.state !== 'detached') throw new Error('Target session is no longer detached');
      // Resume into an unselected chat counts as its FIRST project choice.
      // Preserve the durable lock for this chat even after its MCP session expires.
      const targetWorkspace = this.workspaceStore?.current(target.id);
      if (targetWorkspace && current.contextKey)
        this.workspaceStore?.bindKnown(target.id, targetWorkspace, current.contextKey);
      // A resumed session belongs to the requesting chat from now on. Preserve its
      // workspace/worker, but replace the old chat key so the next request stays here.
      target.contextKey = current.contextKey;
      target.contextSource = current.contextSource;
      target.contextPreview = current.contextPreview;
      target.transportWorkspaceKey = current.transportWorkspaceKey;
      const familyId =
        current.transportSessionId === current.id ? target.id : current.transportSessionId;
      for (const member of this.sessions.values()) {
        if (member.transportSessionId === current.transportSessionId)
          member.transportSessionId = familyId;
      }
      target.transportSessionId = familyId;
      if (target.cleanupTimer) clearTimeout(target.cleanupTimer);
      target.cleanupTimer = null;
      target.state = 'attached';
      target.adapterPid = adapterPid;
      target.detachedAt = null;
      target.lastActivityAt = new Date().toISOString();
      await this.destroySession(current, 'replaced_by_resume');
      await this.log
        .write({
          type: 'session_resumed',
          sessionId: target.id,
          workerId: target.workerId ?? undefined,
          workspaceKey: target.workspaceKey,
          workerPid: target.worker?.status.workerPid ?? null,
          details: { adapterPid },
        })
        .catch(() => {});
      await this.persistState();
      return target.id;
    } finally {
      current.inFlight--;
      target.inFlight--;
      current.changingWorkspace = false;
      target.changingWorkspace = false;
    }
  }

  async prepareUpgrade(): Promise<void> {
    if (this.quiescing || this.shuttingDown) throw new Error('Broker is already stopping');
    this.quiescing = true;
    try {
      const busy = () =>
        this.status.inFlightCalls ||
        this.status.queueDepth ||
        this.startingWorkers ||
        this.stoppingWorkers;
      if (busy()) throw new Error('DWB_UPGRADE_BUSY: finish current requests before updating');
      for (const session of this.sessions.values()) {
        if (session.worker && (await session.worker.hasActiveWork().catch(() => true)))
          throw new Error('DWB_UPGRADE_BUSY: finish background processes/searches before updating');
      }
      if (busy()) throw new Error('DWB_UPGRADE_BUSY: wait for worker retirement before updating');
      await this.persistState();
      if (this.persistenceError) throw new Error(this.persistenceError);
    } catch (error) {
      this.quiescing = false;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const item of this.queue.splice(0)) item.reject(new Error('Broker shutting down'));
    const all = [...this.sessions.values()];
    for (const session of all) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    }
    await Promise.allSettled(all.map((session) => session.allocationPromise));
    await this.idleReclaim;
    await Promise.allSettled(
      all.map((session) => session.retirement ?? this.retireWorker(session)),
    );
    await this.stateWriteChain;
    this.sessions.clear();
  }
}
