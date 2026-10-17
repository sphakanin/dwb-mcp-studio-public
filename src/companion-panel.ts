// ChatGPT conversation panel: status is read-only; project actions require explicit UI clicks.
// Workspace binding and filesystem checks remain server-side.
export const COMPANION_URI = 'ui://dwb-mcp-studio/companion-panel';
export const COMPANION_MIME = 'text/html;profile=mcp-app';

export const companionTools = [
  {
    name: 'dwb_companion',
    title: 'DWB Companion',
    description:
      'Open the DWB Project Launcher beside this conversation. Manage workspaces, create projects in approved roots, attach read-only reference workspaces, and view live DWB status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: {
      ui: { resourceUri: COMPANION_URI, visibility: ['model', 'app'] },
      'openai/ui': { entrypoints: [{ type: 'thread' }] },
      // Compatibility alias for ChatGPT hosts that still inspect the legacy UI key.
      'openai/outputTemplate': COMPANION_URI,
    },
  },
  {
    name: 'dwb_companion_action',
    title: 'DWB Project Launcher action',
    description:
      'Perform a user-confirmed DWB Companion action. A chat may select its primary workspace only once; subsequent changes require a new chat.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'create',
            'switch',
            'add_existing',
            'related_add',
            'related_remove',
            'review_workspace',
            'review_root',
            'apply_review',
            'presentation_configure',
            'presentation_enter',
            'presentation_exit',
          ],
        },
        workspace_id: { type: 'string' },
        home_id: { type: 'string' },
        project_name: { type: 'string' },
        project_kind: { type: 'string', enum: ['blank', 'web', 'docs'] },
        path: { type: 'string' },
        operation: {
          type: 'string',
          enum: ['archive', 'restore', 'unregister', 'relink', 'root_add', 'root_remove'],
        },
        review_token: { type: 'string' },
        demo_workspace_ids: { type: 'array', items: { type: 'string' }, maxItems: 100 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'dwb_companion_snapshot',
    title: 'DWB Companion refresh',
    description: 'Read-only live snapshot for the DWB Companion app.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ['app'] } },
  },
] as const;

type Workspace = { id: string; name: string; root?: string; aliases?: string[] };
type Skill = { id: string; name: string; policy: string };
type Session = {
  sessionId?: string;
  state?: string;
  workerPid?: number | null;
  workerStatus?: { ready?: boolean } | null;
  inFlight?: number;
  queued?: boolean;
  lastActivityAt?: string;
};

export function makeCompanionSnapshot(input: {
  broker: Record<string, unknown>;
  current: Workspace | null;
  workspaces: Workspace[];
  skills: Skill[];
  sessions: Array<Session & { workspaceName?: string | null; workspaceId?: string | null }>;
  presentation?: { enabled: boolean; demoWorkspaceIds: string[] };
  projectHomes?: Array<{ id: string; name: string }>;
  related?: Workspace[];
  referenceLimitReached?: boolean;
  allowedWorkspaceIds?: string[];
  selectionLocked?: boolean;
}) {
  const broker = input.broker;
  const runtime = broker.runtime as { version?: string } | undefined;
  const presentation = input.presentation ?? { enabled: false, demoWorkspaceIds: [] };
  const visible = new Set(presentation.demoWorkspaceIds);
  const canShow = (id: string) => !presentation.enabled || visible.has(id);
  const current = input.current && canShow(input.current.id) ? input.current : null;
  return {
    kind: 'dwb-companion-v1',
    updatedAt: new Date().toISOString(),
    version: runtime?.version ?? 'unknown',
    broker: {
      workerCap: presentation.enabled ? 0 : Number(broker.workerCap ?? 0),
      activeWorkers: presentation.enabled ? 0 : Number(broker.activeWorkers ?? 0),
      queueDepth: presentation.enabled ? 0 : Number(broker.queueDepth ?? 0),
      sessions: presentation.enabled ? 0 : Number(broker.sessions ?? 0),
      inFlightCalls: presentation.enabled ? 0 : Number(broker.inFlightCalls ?? 0),
      persistenceHealthy:
        (broker.persistence as { healthy?: boolean } | undefined)?.healthy === true,
    },
    currentWorkspace: current ? { id: current.id, name: current.name } : null,
    selectionLocked: input.selectionLocked === true || Boolean(input.current),
    presentation,
    referenceLimitReached: input.referenceLimitReached === true,
    projectHomes: (presentation.enabled ? [] : (input.projectHomes ?? [])).map((home) => ({
      id: home.id,
      name: home.name,
    })),
    relatedWorkspaces: (input.related ?? [])
      .filter((w) => canShow(w.id))
      .slice(0, 5)
      .map((w) => ({
        id: w.id,
        name: w.name,
      })),
    workspaces: input.workspaces
      .filter((w) => canShow(w.id))
      .slice(0, 50)
      .map((w) => ({
        available:
          input.allowedWorkspaceIds === undefined || input.allowedWorkspaceIds.includes(w.id),
        id: w.id,
        name: w.name,
        aliases: w.aliases?.slice(0, 4) ?? [],
      })),
    sessions: input.sessions
      .filter((s) => !presentation.enabled || (s.workspaceId && canShow(s.workspaceId)))
      .slice(0, 25)
      .map((s) => ({
        state: s.state ?? 'unknown',
        workspaceName: s.workspaceName ?? 'Unbound',
        ready: s.workerStatus?.ready === true,
        active: Number(s.inFlight ?? 0),
        queued: s.queued === true,
      })),
    skills: (presentation.enabled ? [] : input.skills).slice(0, 30).map((s) => ({
      id: s.id,
      name: s.name,
      policy: s.policy,
    })),
  };
}
