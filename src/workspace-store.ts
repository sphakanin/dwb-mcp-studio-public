import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { CoreStore } from './core-store.js';
import { physicalPath } from './file-observer.js';

export const WORKSPACE_LOCKED_MESSAGE =
  'DWB_WORKSPACE_LOCKED: This chat is locked to its first workspace. Start a new ChatGPT chat to choose another workspace.';

export type PresentationSettings = { enabled: boolean; demoWorkspaceIds: string[] };

export type WorkspaceView = {
  id: string;
  name: string;
  root: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
    : [];
}

function key(value: string): string {
  return value.trim().toLocaleLowerCase();
}
function samePhysicalDirectory(a: string, b: string): boolean {
  try {
    return physicalPath(a) === physicalPath(b);
  } catch {
    return false; // Stale/broken registrations must not block other valid projects.
  }
}
export function pathWithin(root: string, target: string): boolean {
  const rel = relative(physicalPath(root), physicalPath(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class WorkspaceStore {
  constructor(private readonly db: CoreStore) {}

  presentationSettings(): PresentationSettings {
    const row = this.db.one<{ enabled: number; demo_workspace_ids: string }>(
      'SELECT enabled,demo_workspace_ids FROM companion_presentation_settings WHERE setting_id=1',
    );
    if (!row) return { enabled: false, demoWorkspaceIds: [] };
    let ids: unknown = [];
    try {
      ids = JSON.parse(row.demo_workspace_ids);
    } catch {
      // A damaged allowlist must fail closed when Presentation Mode is enabled.
    }
    return {
      enabled: row.enabled === 1,
      demoWorkspaceIds: [...new Set(strings(ids))],
    };
  }

  private savePresentation(settings: PresentationSettings): PresentationSettings {
    this.db.run(
      [
        'INSERT INTO companion_presentation_settings(setting_id,enabled,demo_workspace_ids)',
        'VALUES(1,?,?) ON CONFLICT(setting_id) DO UPDATE SET',
        'enabled=excluded.enabled,demo_workspace_ids=excluded.demo_workspace_ids',
      ].join(' '),
      [settings.enabled ? 1 : 0, JSON.stringify(settings.demoWorkspaceIds)],
    );
    return settings;
  }

  configurePresentation(ids: unknown): PresentationSettings {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim()))
      throw new Error('Demo Allowlist must be an array of workspace IDs.');
    return this.db.transaction(() => {
      const settings = this.presentationSettings();
      if (settings.enabled) throw new Error('Exit Presentation Mode before editing the allowlist.');
      const unique = [...new Set(strings(ids))];
      if (unique.length > 100)
        throw new Error('Demo Allowlist can contain at most 100 workspaces.');
      const known = new Set(this.list().map((workspace) => workspace.id));
      if (unique.some((id) => !known.has(id)))
        throw new Error('Demo Allowlist contains an unknown registered workspace.');
      return this.savePresentation({ enabled: false, demoWorkspaceIds: unique });
    });
  }

  setPresentationEnabled(
    enabled: boolean,
    eligibleWorkspaceIds: string[] = [],
  ): PresentationSettings {
    return this.db.transaction(() => {
      const settings = this.presentationSettings();
      if (enabled && !settings.demoWorkspaceIds.some((id) => eligibleWorkspaceIds.includes(id)))
        throw new Error(
          'Choose at least one accessible Demo Workspace before entering Presentation Mode.',
        );
      return this.savePresentation({ ...settings, enabled });
    });
  }

  mutationGate(input: { sessionId: string; kind: string; paths: string[] }) {
    const logical = this.current(input.sessionId);
    if (logical && input.kind === 'file-mutation') {
      const outside = input.paths.filter((path) => !pathWithin(logical.root, path));
      if (outside.length)
        return {
          allowed: false,
          message: `DWB_WORKSPACE_BOUNDARY: bind the intended workspace before changing files outside ${logical.root}.\n${outside.join('\n')}`,
        };
    }
    return { allowed: true, message: '' };
  }

  private aliases(id: string): string[] {
    return this.db
      .query<any>('SELECT alias FROM workspace_aliases WHERE workspace_id=? ORDER BY alias', [id])
      .map((row) => String(row.alias));
  }

  private view(row: any): WorkspaceView {
    return {
      id: String(row.id),
      name: String(row.name),
      root: String(row.root_path),
      aliases: this.aliases(String(row.id)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt:
        this.db.one<{ archived_at: string }>(
          'SELECT archived_at FROM workspace_archives WHERE workspace_id=?',
          [String(row.id)],
        )?.archived_at ?? null,
    };
  }

  private row(id: string) {
    return this.db.one<any>('SELECT * FROM workspaces WHERE id=?', [id]);
  }

  list(): WorkspaceView[] {
    return this.db
      .query<any>('SELECT * FROM workspaces ORDER BY updated_at DESC,name')
      .map((row) => this.view(row));
  }
  current(sessionId: string): WorkspaceView | null {
    const row = this.db.one<any>(
      [
        'SELECT w.* FROM session_workspace_bindings b JOIN workspaces w ON w.id=b.workspace_id',
        'WHERE b.session_id=?',
      ].join(' '),
      [sessionId],
    );
    return row ? this.view(row) : null;
  }

  related(sessionId: string): WorkspaceView[] {
    const activeId = this.current(sessionId)?.id;
    return this.db
      .query<{ workspace_id: string }>(
        'SELECT workspace_id FROM companion_related_workspaces WHERE session_id=? ORDER BY added_at',
        [sessionId],
      )
      .filter((item) => item.workspace_id !== activeId)
      .map((item) => this.row(item.workspace_id))
      .filter((item) => Boolean(item))
      .map((item) => this.view(item))
      .filter((workspace) => workspace.archivedAt === null);
  }

  addRelated(sessionId: string, workspaceId: string): WorkspaceView[] {
    return this.db.transaction(() => {
      const target = this.resolveRef(workspaceId);
      if (target.archivedAt) throw new Error('Archived workspaces cannot be references.');
      if (this.current(sessionId)?.id === target.id)
        throw new Error('The active workspace is already available to the conversation.');
      const exists = this.db.one(
        'SELECT workspace_id FROM companion_related_workspaces WHERE session_id=? AND workspace_id=?',
        [sessionId, target.id],
      );
      const currentCount =
        this.db.one<{ count: number }>(
          'SELECT COUNT(*) AS count FROM companion_related_workspaces WHERE session_id=?',
          [sessionId],
        )?.count ?? 0;
      if (!exists && currentCount >= 5)
        throw new Error('Up to five related workspaces can be added.');
      this.db.run(
        'INSERT OR IGNORE INTO companion_related_workspaces(session_id,workspace_id,added_at) VALUES(?,?,?)',
        [sessionId, target.id, new Date().toISOString()],
      );
      return this.related(sessionId);
    });
  }

  removeRelated(sessionId: string, workspaceId: string): WorkspaceView[] {
    return this.db.transaction(() => {
      this.db.run(
        'DELETE FROM companion_related_workspaces WHERE session_id=? AND workspace_id=?',
        [sessionId, workspaceId],
      );
      return this.related(sessionId);
    });
  }

  usage(workspaceId: string): { bindings: number; references: number } {
    return {
      bindings:
        this.db.one<{ n: number }>(
          'SELECT COUNT(*) AS n FROM session_workspace_bindings WHERE workspace_id=?',
          [workspaceId],
        )?.n ?? 0,
      references:
        this.db.one<{ n: number }>(
          'SELECT COUNT(*) AS n FROM companion_related_workspaces WHERE workspace_id=?',
          [workspaceId],
        )?.n ?? 0,
    };
  }

  private requireUnused(workspaceId: string): void {
    const usage = this.usage(workspaceId);
    if (usage.bindings || usage.references)
      throw new Error(
        'Workspace is still bound or used as a reference. Unbind/remove references before managing it.',
      );
  }

  archive(workspaceId: string, sessionId: string): WorkspaceView {
    return this.db.transaction(() => {
      const workspace = this.exact(workspaceId);
      if (workspace.archivedAt) throw new Error('Workspace is already archived.');
      this.requireUnused(workspace.id);
      this.db.run('INSERT INTO workspace_archives(workspace_id,archived_at) VALUES(?,?)', [
        workspace.id,
        new Date().toISOString(),
      ]);
      this.event(workspace.id, 'archived', sessionId);
      return this.exact(workspace.id);
    });
  }

  restore(workspaceId: string, sessionId: string): WorkspaceView {
    return this.db.transaction(() => {
      const workspace = this.exact(workspaceId);
      if (!workspace.archivedAt) throw new Error('Workspace is not archived.');
      this.db.run('DELETE FROM workspace_archives WHERE workspace_id=?', [workspace.id]);
      this.event(workspace.id, 'restored', sessionId);
      return this.exact(workspace.id);
    });
  }

  unregister(workspaceId: string, sessionId: string): { unregistered: string } {
    return this.db.transaction(() => {
      const workspace = this.exact(workspaceId);
      if (!workspace.archivedAt)
        throw new Error('Archive this workspace before removing its registry entry.');
      this.requireUnused(workspace.id);
      this.event(workspace.id, 'unregistered', sessionId, {
        name: workspace.name,
        root: workspace.root,
      });
      this.db.run('DELETE FROM workspace_aliases WHERE workspace_id=?', [workspace.id]);
      this.db.run('DELETE FROM workspace_archives WHERE workspace_id=?', [workspace.id]);
      this.db.run('DELETE FROM workspaces WHERE id=?', [workspace.id]);
      return { unregistered: workspace.id };
    });
  }

  async relink(workspaceId: string, newPath: string, sessionId: string): Promise<WorkspaceView> {
    if (!isAbsolute(newPath)) throw new Error('Relink needs an absolute existing directory.');
    const canonical = await realpath(newPath);
    if (!(await stat(canonical)).isDirectory())
      throw new Error('Relink target must be a directory.');
    return this.db.transaction(() => {
      const workspace = this.exact(workspaceId);
      this.requireUnused(workspace.id);
      const other = this.db
        .query<{ id: string; root_path: string }>(
          'SELECT id,root_path FROM workspaces WHERE id<>?',
          [workspace.id],
        )
        .find((item) => samePhysicalDirectory(item.root_path, canonical));
      if (other) throw new Error('The target directory is already registered.');
      this.db.run('UPDATE workspaces SET root_path=?,updated_at=? WHERE id=?', [
        canonical,
        new Date().toISOString(),
        workspace.id,
      ]);
      this.event(workspace.id, 'relinked', sessionId, { from: workspace.root, to: canonical });
      return this.exact(workspace.id);
    });
  }

  exact(workspaceId: string): WorkspaceView {
    const row = this.row(workspaceId);
    if (!row) throw new Error('Unknown workspace ID.');
    return this.view(row);
  }

  workspaceForPath(path: string): WorkspaceView | null {
    const target = resolve(path);
    const matches = this.db
      .query<any>('SELECT * FROM workspaces')
      .filter((row) => pathWithin(String(row.root_path), target))
      .sort((a, b) => String(b.root_path).length - String(a.root_path).length);
    return matches[0] ? this.view(matches[0]) : null;
  }

  private candidateRows(ref: string): any[] {
    if (process.platform !== 'win32' && isAbsolute(ref)) {
      return this.db.query<any>('SELECT * FROM workspaces WHERE root_path=? COLLATE BINARY', [
        physicalPath(ref),
      ]);
    }
    const needle = key(ref);
    const exact = this.db.query<any>(
      [
        'SELECT DISTINCT w.* FROM workspaces w LEFT JOIN workspace_aliases a ON a.workspace_id=w.id',
        'WHERE lower(w.id)=? OR lower(w.name)=? OR lower(w.root_path)=? OR lower(a.alias)=?',
      ].join(' '),
      [needle, needle, needle, needle],
    );
    if (exact.length) return exact;
    const like = `%${needle}%`;
    return this.db.query<any>(
      [
        'SELECT DISTINCT w.* FROM workspaces w LEFT JOIN workspace_aliases a ON a.workspace_id=w.id',
        'WHERE lower(w.id) LIKE ? OR lower(w.name) LIKE ? OR lower(a.alias) LIKE ?',
      ].join(' '),
      [like, like, like],
    );
  }
  resolveRef(ref: string): WorkspaceView {
    const rows = this.candidateRows(ref);
    if (!rows.length) throw new Error(`Unknown workspace: ${ref}`);
    if (rows.length > 1) {
      const labels = rows
        .slice(0, 8)
        .map((row) => `${row.name} (${row.id})`)
        .join(', ');
      throw new Error(`DWB_WORKSPACE_AMBIGUOUS: ${ref} matches ${labels}`);
    }
    return this.view(rows[0]);
  }

  private addAliases(workspaceId: string, values: string[], now: string) {
    for (const raw of values) {
      const alias = raw.trim();
      if (!alias) continue;
      const owner = this.db.one<any>(
        'SELECT workspace_id FROM workspace_aliases WHERE lower(alias)=lower(?)',
        [alias],
      );
      if (owner && String(owner.workspace_id) !== workspaceId) {
        throw new Error(`Workspace alias already belongs to another workspace: ${alias}`);
      }
      this.db.run(
        'INSERT OR IGNORE INTO workspace_aliases(workspace_id,alias,created_at) VALUES (?,?,?)',
        [workspaceId, alias, now],
      );
    }
  }

  private event(
    workspaceId: string,
    type: string,
    sessionId: string | null,
    details: unknown = null,
  ) {
    this.db.run(
      'INSERT INTO workspace_events(workspace_id,ts,type,session_id,details_json) VALUES (?,?,?,?,?)',
      [
        workspaceId,
        new Date().toISOString(),
        type,
        sessionId,
        details == null ? null : JSON.stringify(details),
      ],
    );
  }
  async register(args: Record<string, unknown>, sessionId?: string): Promise<WorkspaceView> {
    const rawPath = text(args.path) || text(args.root) || text(args.workspace);
    if (!rawPath) throw new Error('workspace.register requires path/root/workspace.');
    if (!isAbsolute(rawPath)) throw new Error('Workspace directory must be an absolute path.');
    const root = process.platform === 'win32' ? resolve(rawPath) : physicalPath(rawPath);
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory())
      throw new Error(`Workspace path is not an existing directory: ${root}`);
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const existing = this.db
        .query<any>('SELECT * FROM workspaces')
        .find((row) => samePhysicalDirectory(String(row.root_path), root));
      const name = text(args.name) || (existing ? String(existing.name) : basename(root));
      let id = existing ? String(existing.id) : `ws_${randomUUID().slice(0, 8)}`;
      if (!existing) {
        this.db.run(
          'INSERT INTO workspaces(id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)',
          [id, name, root, now, now],
        );
      } else if (name !== String(existing.name)) {
        this.db.run('UPDATE workspaces SET name=?,updated_at=? WHERE id=?', [name, now, id]);
      }
      const autoAliases = [name, basename(root), key(name).replace(/[^a-z0-9]+/g, '-')];
      // Distinct projects may have the same folder name. Keep explicit aliases unique,
      // but do not prevent binding an exact directory because an automatic alias exists.
      const availableAliases = autoAliases.filter((alias) => {
        const owner = this.db.one<any>(
          'SELECT workspace_id FROM workspace_aliases WHERE lower(alias)=lower(?)',
          [alias],
        );
        return !owner || String(owner.workspace_id) === id;
      });
      this.addAliases(id, [...availableAliases, ...strings(args.aliases)], now);
      this.event(id, existing ? 'registered_again' : 'registered', sessionId ?? null, {
        root,
        name,
      });
      return this.view(this.row(id));
    });
  }

  contextLock(contextKey: string | null | undefined): string | null {
    if (!contextKey) return null;
    return (
      this.db.one<{ workspace_id: string }>(
        'SELECT workspace_id FROM conversation_workspace_locks WHERE context_key=?',
        [contextKey],
      )?.workspace_id ?? null
    );
  }

  bindKnown(
    sessionId: string,
    workspace: WorkspaceView,
    contextKey: string | null = null,
  ): WorkspaceView {
    return this.db.transaction(() => {
      const current = this.current(sessionId);
      const lockedId = this.contextLock(contextKey);
      if ((current && current.id !== workspace.id) || (lockedId && lockedId !== workspace.id))
        throw new Error(WORKSPACE_LOCKED_MESSAGE);
      const now = new Date().toISOString();
      if (contextKey && !lockedId)
        this.db.run(
          'INSERT INTO conversation_workspace_locks(context_key,workspace_id,selected_at) VALUES(?,?,?)',
          [contextKey, workspace.id, now],
        );
      if (current) return current;
      this.db.run(
        [
          'INSERT INTO session_workspace_bindings(session_id,workspace_id,bound_at,updated_at) VALUES (?,?,?,?)',
          'ON CONFLICT(session_id) DO UPDATE SET workspace_id=excluded.workspace_id,updated_at=excluded.updated_at',
        ].join(' '),
        [sessionId, workspace.id, now, now],
      );
      this.event(workspace.id, 'bound', sessionId, {});
      return workspace;
    });
  }
  async resolveBinding(args: Record<string, unknown>, sessionId: string): Promise<WorkspaceView> {
    const ref =
      text(args.path) || text(args.workspace) || text(args.workspace_id) || text(args.name);
    if (!ref) throw new Error('workspace.bind requires workspace/workspace_id/name/path.');
    let workspace: WorkspaceView;
    if (text(args.path) && !isAbsolute(ref))
      throw new Error('Workspace directory must be an absolute path.');
    if (isAbsolute(ref)) {
      workspace = await this.register(
        { path: ref, name: args.name, aliases: args.aliases },
        sessionId,
      );
    } else {
      workspace = this.resolveRef(ref);
      if (workspace.archivedAt) throw new Error('Restore the archived workspace before binding.');
      if (!(await stat(workspace.root).catch(() => null))?.isDirectory())
        throw new Error(`Workspace path is not an existing directory: ${workspace.root}`);
    }
    return workspace;
  }
  async bind(args: Record<string, unknown>, sessionId: string): Promise<WorkspaceView> {
    return this.bindKnown(sessionId, await this.resolveBinding(args, sessionId));
  }

  // Broker-only lifecycle cleanup; this is NOT an in-chat Unbind action.
  // Keep conversation_workspace_locks so reopening the same chat cannot reselect.
  releaseExpiredSession(sessionId: string): void {
    this.db.transaction(() => {
      const current = this.current(sessionId);
      this.db.run('DELETE FROM companion_related_workspaces WHERE session_id=?', [sessionId]);
      this.db.run('DELETE FROM session_workspace_bindings WHERE session_id=?', [sessionId]);
      if (current) this.event(current.id, 'session_binding_expired', sessionId);
    });
  }

  unbind(sessionId: string) {
    const current = this.current(sessionId);
    if (current) throw new Error(WORKSPACE_LOCKED_MESSAGE);
    return { unbound: false, previous: null };
  }

  async handle(args: Record<string, unknown>, sessionId: string) {
    const action = text(args.action);
    if (action === 'list') return { workspaces: this.list(), current: this.current(sessionId) };
    if (action === 'status') return { workspace: this.current(sessionId) };
    if (action === 'register') return { workspace: await this.register(args, sessionId) };
    if (action === 'bind') return { workspace: await this.bind(args, sessionId) };
    if (action === 'resolve')
      return { workspace: this.resolveRef(text(args.workspace) || text(args.query)) };
    if (action === 'unbind') return this.unbind(sessionId);
    throw new Error(
      'workspace.action must be one of: list, status, register, bind, resolve, unbind.',
    );
  }
}
