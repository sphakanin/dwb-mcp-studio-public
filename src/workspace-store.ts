import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { CoreStore } from './core-store.js';
import { physicalPath } from './file-observer.js';

export type WorkspaceView = {
  id: string;
  name: string;
  root: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
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
export function pathWithin(root: string, target: string): boolean {
  const rel = relative(physicalPath(root), physicalPath(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class WorkspaceStore {
  constructor(private readonly db: CoreStore) {}

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
      const existing = this.db.one<any>(
        process.platform === 'win32'
          ? 'SELECT * FROM workspaces WHERE lower(root_path)=lower(?)'
          : 'SELECT * FROM workspaces WHERE root_path=? COLLATE BINARY',
        [root],
      );
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

  bindKnown(sessionId: string, workspace: WorkspaceView): WorkspaceView {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
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
      if (!(await stat(workspace.root).catch(() => null))?.isDirectory())
        throw new Error(`Workspace path is not an existing directory: ${workspace.root}`);
    }
    return workspace;
  }
  async bind(args: Record<string, unknown>, sessionId: string): Promise<WorkspaceView> {
    return this.bindKnown(sessionId, await this.resolveBinding(args, sessionId));
  }

  unbind(sessionId: string) {
    return this.db.transaction(() => {
      const current = this.current(sessionId);
      this.db.run('DELETE FROM session_workspace_bindings WHERE session_id=?', [sessionId]);
      if (current) this.event(current.id, 'unbound', sessionId, {});
      return { unbound: Boolean(current), previous: current };
    });
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
