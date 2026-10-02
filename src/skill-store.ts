import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir } from './paths.js';

export type SkillPolicy = 'auto' | 'ask' | 'manual';
export type SkillView = {
  id: string;
  name: string;
  description: string;
  sourceType: string;
  sourceRef: string;
  installPath: string;
  contentHash: string;
  defaultPolicy: SkillPolicy;
  policy: SkillPolicy;
  installedAt: string;
  updatedAt: string;
};

type SkillStoreOptions = { dbPath?: string; libraryRoot?: string };
type InstallArgs = {
  sourceDir: string;
  defaultPolicy?: SkillPolicy;
  sourceType?: string;
  sourceRef?: string;
};
type ActivateArgs = {
  sessionId: string;
  workspaceId: string;
  skillId: string;
  explicitUserRequest?: boolean;
  userConfirmed?: boolean;
  approvalId?: string;
};

function policy(value: unknown, fallback: SkillPolicy = 'ask'): SkillPolicy {
  return value === 'auto' || value === 'ask' || value === 'manual' ? value : fallback;
}

function parseFrontmatter(raw: string) {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) throw new Error('SKILL.md must start with YAML frontmatter.');
  const end = text.indexOf('\n---', 4);
  if (end < 0) throw new Error('SKILL.md frontmatter is not closed.');
  const front = text.slice(4, end);
  const lines = front.split('\n');
  const nameLine = lines.find((line) => /^name\s*:/.test(line));
  if (!nameLine) throw new Error('SKILL.md frontmatter requires name.');
  const name = nameLine
    .replace(/^name\s*:\s*/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))
    throw new Error(
      'Skill name must be 1-64 characters using letters, numbers, dot, underscore or dash.',
    );
  let description = '';
  const index = lines.findIndex((line) => /^description\s*:/.test(line));
  if (index >= 0) {
    const first = lines[index].replace(/^description\s*:\s*/, '').trim();
    if (first === '>' || first === '|') {
      const parts: string[] = [];
      for (let i = index + 1; i < lines.length; i++) {
        if (/^[A-Za-z0-9_-]+\s*:/.test(lines[i])) break;
        if (lines[i].trim()) parts.push(lines[i].trim());
      }
      description = parts.join(' ');
    } else description = first.replace(/^['"]|['"]$/g, '');
  }
  return { id: name.toLocaleLowerCase(), name, description };
}

function inside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

async function copyTree(source: string, target: string) {
  let files = 0;
  let bytes = 0;
  async function walk(from: string, to: string) {
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error('Skill packages may not contain symbolic links.');
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true });
      for (const entry of await readdir(from)) await walk(join(from, entry), join(to, entry));
      return;
    }
    if (!info.isFile())
      throw new Error('Skill packages may contain only regular files and folders.');
    files++;
    bytes += info.size;
    if (files > 512 || bytes > 8 * 1024 * 1024)
      throw new Error('Skill package exceeds the V1 safety limit (512 files / 8 MiB).');
    await mkdir(resolve(to, '..'), { recursive: true });
    await writeFile(to, await readFile(from));
  }
  await walk(source, target);
}

export class SkillStore {
  readonly path: string;
  readonly libraryRoot: string;
  private readonly db: DatabaseSync;

  constructor(options: SkillStoreOptions = {}) {
    this.path = resolve(options.dbPath || join(dataDir(), 'runtime', 'skills.db'));
    this.libraryRoot = resolve(options.libraryRoot || join(dataDir(), 'skills'));
    mkdirSync(resolve(this.path, '..'), { recursive: true });
    mkdirSync(this.libraryRoot, { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL, source_ref TEXT NOT NULL, install_path TEXT NOT NULL,
        content_hash TEXT NOT NULL, default_policy TEXT NOT NULL DEFAULT 'ask',
        installed_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_skill_policies (
        workspace_id TEXT NOT NULL, skill_id TEXT NOT NULL, policy TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id,skill_id));

      CREATE TABLE IF NOT EXISTS skill_approvals (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        skill_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, decided_at TEXT, consumed_at TEXT);
      CREATE INDEX IF NOT EXISTS skill_approvals_pending
        ON skill_approvals(status,workspace_id,skill_id,session_id);
      CREATE TABLE IF NOT EXISTS skill_session_activations (
        session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, skill_id TEXT NOT NULL,
        activated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        PRIMARY KEY(session_id,workspace_id,skill_id));
    `);
  }

  close() {
    this.db.close();
  }

  private row(id: string) {
    return this.db.prepare('SELECT * FROM skills WHERE id=?').get(id.toLocaleLowerCase()) as any;
  }

  private effectivePolicy(skillId: string, workspaceId?: string): SkillPolicy {
    if (workspaceId) {
      const override = this.db
        .prepare('SELECT policy FROM workspace_skill_policies WHERE workspace_id=? AND skill_id=?')
        .get(workspaceId, skillId.toLocaleLowerCase()) as any;
      if (override) return policy(override.policy);
    }
    const row = this.row(skillId);
    if (!row) throw new Error(`Unknown skill: ${skillId}`);
    return policy(row.default_policy);
  }

  private view(row: any, workspaceId?: string): SkillView {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ''),
      sourceType: String(row.source_type),
      sourceRef: String(row.source_ref),
      installPath: String(row.install_path),
      contentHash: String(row.content_hash),
      defaultPolicy: policy(row.default_policy),
      policy: this.effectivePolicy(String(row.id), workspaceId),
      installedAt: String(row.installed_at),
      updatedAt: String(row.updated_at),
    };
  }

  list(workspaceId?: string): SkillView[] {
    return (this.db.prepare('SELECT * FROM skills ORDER BY name').all() as any[]).map((row) =>
      this.view(row, workspaceId),
    );
  }

  get(skillId: string, workspaceId?: string): SkillView | null {
    const row = this.row(skillId);
    return row ? this.view(row, workspaceId) : null;
  }

  workspacePolicyOverrides(workspaceId: string): Record<string, SkillPolicy> {
    const rows = this.db
      .prepare('SELECT skill_id,policy FROM workspace_skill_policies WHERE workspace_id=?')
      .all(workspaceId) as any[];
    return Object.fromEntries(
      rows.map((row) => [String(row.skill_id), policy(row.policy)]),
    ) as Record<string, SkillPolicy>;
  }

  async installLocal(args: InstallArgs): Promise<SkillView> {
    const sourceDir = resolve(args.sourceDir);
    const sourceInfo = await lstat(sourceDir).catch(() => null);
    if (!sourceInfo?.isDirectory())
      throw new Error(`Skill source is not a directory: ${sourceDir}`);
    if (sourceInfo.isSymbolicLink())
      throw new Error('Skill source directory may not be a symbolic link.');

    const raw = await readFile(join(sourceDir, 'SKILL.md'), 'utf8');
    const meta = parseFrontmatter(raw);
    const hash = createHash('sha256').update(raw).digest('hex');
    // Each published package has its own path; an old reader cannot see new files.
    const finalPath = resolve(this.libraryRoot, `${meta.id}-${randomUUID()}`);
    const staging = resolve(this.libraryRoot, `.${meta.id}.stage-${randomUUID()}`);
    if (!inside(this.libraryRoot, finalPath) || !inside(this.libraryRoot, staging))
      throw new Error('Invalid managed skill path.');

    await rm(staging, { recursive: true, force: true });
    try {
      await copyTree(sourceDir, staging);
      await rename(staging, finalPath);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    let previous: any;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      previous = this.row(meta.id);
      const now = new Date().toISOString();
      const defaultPolicy = policy(
        args.defaultPolicy,
        previous ? policy(previous.default_policy) : 'ask',
      );
      this.db
        .prepare(
          [
            'INSERT INTO skills(id,name,description,source_type,source_ref,install_path,content_hash,default_policy,installed_at,updated_at)',
            'VALUES (?,?,?,?,?,?,?,?,?,?)',
            'ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,',
            'source_type=excluded.source_type,source_ref=excluded.source_ref,install_path=excluded.install_path,',
            'content_hash=excluded.content_hash,default_policy=excluded.default_policy,updated_at=excluded.updated_at',
          ].join(' '),
        )
        .run(
          meta.id,
          meta.name,
          meta.description,
          args.sourceType || 'local',
          args.sourceRef || sourceDir,
          finalPath,
          hash,
          defaultPolicy,
          previous ? String(previous.installed_at) : now,
          now,
        );
      // A reinstall requires fresh consent even when only companion files changed.
      this.db.prepare('DELETE FROM skill_approvals WHERE skill_id=?').run(meta.id);
      this.db.prepare('DELETE FROM skill_session_activations WHERE skill_id=?').run(meta.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      await rm(finalPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    if (previous && inside(this.libraryRoot, String(previous.install_path))) {
      await rm(String(previous.install_path), { recursive: true, force: true }).catch(() => {});
    }
    return this.get(meta.id)!;
  }

  async readSkillFile(skillId: string, relativePath: string): Promise<string> {
    const row = this.row(skillId);
    if (!row) throw new Error(`Unknown skill: ${skillId}`);
    if (!relativePath || isAbsolute(relativePath))
      throw new Error('Skill file path must be relative.');
    const root = resolve(String(row.install_path));
    const target = resolve(root, relativePath);
    if (!inside(root, target)) throw new Error('Skill file path escapes the managed package.');
    const info = await lstat(target).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink())
      throw new Error('Skill file is not a regular file.');
    return readFile(target, 'utf8');
  }

  async uninstall(skillId: string) {
    const id = skillId.toLocaleLowerCase();
    const row = this.row(id);
    if (!row) throw new Error(`Unknown skill: ${skillId}`);
    const installPath = resolve(String(row.install_path));
    if (!inside(this.libraryRoot, installPath))
      throw new Error('Refusing to remove a skill outside the managed library.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM skill_session_activations WHERE skill_id=?').run(id);
      this.db.prepare('DELETE FROM skill_approvals WHERE skill_id=?').run(id);
      this.db.prepare('DELETE FROM workspace_skill_policies WHERE skill_id=?').run(id);
      this.db.prepare('DELETE FROM skills WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    await rm(installPath, { recursive: true, force: true });
    return { uninstalled: true, id };
  }

  async setDefaultPolicy(skillId: string, next: SkillPolicy) {
    const id = skillId.toLocaleLowerCase();
    if (!this.row(id)) throw new Error(`Unknown skill: ${skillId}`);
    const value = policy(next);
    this.db
      .prepare('UPDATE skills SET default_policy=?,updated_at=? WHERE id=?')
      .run(value, new Date().toISOString(), id);
    return this.get(id)!;
  }

  async setWorkspacePolicy(workspaceId: string, skillId: string, next: SkillPolicy) {
    const id = skillId.toLocaleLowerCase();
    if (!workspaceId) throw new Error('workspaceId is required.');
    if (!this.row(id)) throw new Error(`Unknown skill: ${skillId}`);
    const value = policy(next);
    this.db
      .prepare(
        [
          'INSERT INTO workspace_skill_policies(workspace_id,skill_id,policy,updated_at) VALUES (?,?,?,?)',
          'ON CONFLICT(workspace_id,skill_id) DO UPDATE SET policy=excluded.policy,updated_at=excluded.updated_at',
        ].join(' '),
      )
      .run(workspaceId, id, value, new Date().toISOString());
    return this.get(id, workspaceId)!;
  }

  clearWorkspacePolicy(workspaceId: string, skillId: string) {
    this.db
      .prepare('DELETE FROM workspace_skill_policies WHERE workspace_id=? AND skill_id=?')
      .run(workspaceId, skillId.toLocaleLowerCase());
    return this.get(skillId, workspaceId);
  }

  private expireApprovals() {
    this.db
      .prepare(
        "UPDATE skill_approvals SET status='expired',decided_at=? WHERE status='pending' AND expires_at<=?",
      )
      .run(new Date().toISOString(), new Date().toISOString());
  }

  pendingApprovals() {
    this.expireApprovals();
    return this.db
      .prepare(
        [
          'SELECT a.*,s.name,s.description FROM skill_approvals a',
          'JOIN skills s ON s.id=a.skill_id',
          "WHERE a.status='pending' ORDER BY a.created_at",
        ].join(' '),
      )
      .all() as any[];
  }

  decideApproval(approvalId: string, decision: 'approved' | 'rejected') {
    this.expireApprovals();
    const row = this.db.prepare('SELECT * FROM skill_approvals WHERE id=?').get(approvalId) as any;
    if (!row) throw new Error(`Unknown skill approval: ${approvalId}`);
    if (row.status !== 'pending') throw new Error(`Skill approval is already ${row.status}.`);
    this.db
      .prepare('UPDATE skill_approvals SET status=?,decided_at=? WHERE id=?')
      .run(decision, new Date().toISOString(), approvalId);
    return { ...row, status: decision };
  }

  private instructions(skillId: string): string {
    const row = this.row(skillId);
    if (!row) throw new Error(`Unknown skill: ${skillId}`);
    return readFileSync(join(String(row.install_path), 'SKILL.md'), 'utf8');
  }

  private markActivated(sessionId: string, workspaceId: string, skillId: string) {
    const now = new Date();
    const expires = new Date(now.getTime() + 60 * 60 * 1000);
    this.db
      .prepare(
        [
          'INSERT INTO skill_session_activations(session_id,workspace_id,skill_id,activated_at,expires_at)',
          'VALUES (?,?,?,?,?) ON CONFLICT(session_id,workspace_id,skill_id)',
          'DO UPDATE SET activated_at=excluded.activated_at,expires_at=excluded.expires_at',
        ].join(' '),
      )
      .run(sessionId, workspaceId, skillId, now.toISOString(), expires.toISOString());
  }

  isActivated(sessionId: string, workspaceId: string, skillId: string) {
    const row = this.db
      .prepare(
        'SELECT expires_at FROM skill_session_activations WHERE session_id=? AND workspace_id=? AND skill_id=?',
      )
      .get(sessionId, workspaceId, skillId.toLocaleLowerCase()) as any;
    return Boolean(row && Date.parse(String(row.expires_at)) > Date.now());
  }

  async readActivatedSkillFile(
    sessionId: string,
    workspaceId: string,
    skillId: string,
    relativePath: string,
  ) {
    if (!this.isActivated(sessionId, workspaceId, skillId))
      throw new Error('DWB_SKILL_NOT_ACTIVE: activate the skill before reading companion files.');
    const content = await this.readSkillFile(skillId, relativePath);
    if (!this.isActivated(sessionId, workspaceId, skillId))
      throw new Error('DWB_SKILL_NOT_ACTIVE: the skill changed while reading; activate it again.');
    return content;
  }

  async readActivatedSkillPage(
    sessionId: string,
    workspaceId: string,
    skillId: string,
    relativePath: string,
    offset = 0,
    length = 8192,
  ) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error('offset must be a non-negative integer byte offset.');
    if (!Number.isSafeInteger(length) || length < 4 || length > 65536)
      throw new Error('length must be an integer between 4 and 65536 bytes.');
    const bytes = Buffer.from(
      await this.readActivatedSkillFile(sessionId, workspaceId, skillId, relativePath),
      'utf8',
    );
    if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80))
      throw new Error('offset must be a UTF-8 boundary within the file; use nextOffset.');
    let end = Math.min(bytes.length, offset + length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return {
      content: bytes.subarray(offset, end).toString('utf8'),
      offset,
      nextOffset: end < bytes.length ? end : null,
      totalBytes: bytes.length,
    };
  }

  activate(args: ActivateArgs): ReturnType<SkillStore['activateCurrent']> {
    // Serialize consent consumption with package publication in other processes.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.activateCurrent(args);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private activateCurrent(args: ActivateArgs): {
    status: 'active' | 'approval_required' | 'manual_only' | 'rejected';
    policy: SkillPolicy;
    approvalId?: string;
    instructions?: string;
    message?: string;
  } {
    const id = args.skillId.toLocaleLowerCase();
    const row = this.row(id);
    if (!row) throw new Error(`Unknown skill: ${args.skillId}`);
    const effective = this.effectivePolicy(id, args.workspaceId);
    if (effective === 'manual' && !args.explicitUserRequest)
      return {
        status: 'manual_only',
        policy: effective,
        message:
          'This Skill is MANUAL for the workspace. Activate it only for an explicit user request.',
      };
    if (effective !== 'ask') {
      this.markActivated(args.sessionId, args.workspaceId, id);
      return { status: 'active', policy: effective, instructions: this.instructions(id) };
    }

    this.expireApprovals();
    if (args.approvalId) {
      const approved = this.db
        .prepare(
          'SELECT * FROM skill_approvals WHERE id=? AND session_id=? AND workspace_id=? AND skill_id=?',
        )
        .get(args.approvalId, args.sessionId, args.workspaceId, id) as any;
      if (approved?.status === 'rejected') return { status: 'rejected', policy: effective };
      if (approved?.status === 'pending' && args.userConfirmed) {
        const now = new Date().toISOString();
        this.db
          .prepare(
            "UPDATE skill_approvals SET status='approved',decided_at=?,consumed_at=? WHERE id=? AND status='pending'",
          )
          .run(now, now, args.approvalId);
        this.markActivated(args.sessionId, args.workspaceId, id);
        return { status: 'active', policy: effective, instructions: this.instructions(id) };
      }
      if (approved?.status === 'approved' && !approved.consumed_at) {
        this.db
          .prepare('UPDATE skill_approvals SET consumed_at=? WHERE id=?')
          .run(new Date().toISOString(), args.approvalId);
        this.markActivated(args.sessionId, args.workspaceId, id);
        return { status: 'active', policy: effective, instructions: this.instructions(id) };
      }
    }

    const existing = this.db
      .prepare(
        [
          'SELECT * FROM skill_approvals WHERE session_id=? AND workspace_id=? AND skill_id=?',
          "AND status='pending' ORDER BY created_at DESC LIMIT 1",
        ].join(' '),
      )
      .get(args.sessionId, args.workspaceId, id) as any;
    if (existing)
      return {
        status: 'approval_required',
        policy: effective,
        approvalId: existing.id,
        message:
          'Ask the user whether to use this Skill. After an explicit yes, retry with the same approval_id and user_confirmed=true. The request can also be approved in DWB MCP Studio > Agent Skills.',
      };

    const approvalId = `skillreq_${randomUUID().slice(0, 12)}`;
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60 * 1000);
    this.db
      .prepare(
        'INSERT INTO skill_approvals(id,session_id,workspace_id,skill_id,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        approvalId,
        args.sessionId,
        args.workspaceId,
        id,
        'pending',
        now.toISOString(),
        expires.toISOString(),
      );
    return {
      status: 'approval_required',
      policy: effective,
      approvalId,
      message:
        'Ask the user whether to use this Skill. After an explicit yes, retry with the same approval_id and user_confirmed=true. The request can also be approved in DWB MCP Studio > Agent Skills.',
    };
  }
}
