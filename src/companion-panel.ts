// Read-only ChatGPT conversation panel. No worker allocation or file access here.
export const COMPANION_URI = 'ui://dwb-mcp-studio/companion-panel';
export const COMPANION_MIME = 'text/html;profile=mcp-app';

export const companionTools = [
  {
    name: 'dwb_companion',
    title: 'DWB Companion',
    description:
      'Open the DWB MCP Studio Companion in the conversation side panel. Shows registered workspaces, live broker health, sessions and installed Agent Skills. Read-only: selecting a workspace asks ChatGPT to bind it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: {
      ui: { resourceUri: COMPANION_URI, visibility: ['model', 'app'] },
      'openai/ui': { entrypoints: [{ type: 'thread' }] },
    },
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
  sessions: Array<Session & { workspaceName?: string | null }>;
}) {
  const broker = input.broker;
  const runtime = broker.runtime as { version?: string } | undefined;
  return {
    kind: 'dwb-companion-v1',
    updatedAt: new Date().toISOString(),
    version: runtime?.version ?? 'unknown',
    broker: {
      workerCap: Number(broker.workerCap ?? 0),
      activeWorkers: Number(broker.activeWorkers ?? 0),
      queueDepth: Number(broker.queueDepth ?? 0),
      sessions: Number(broker.sessions ?? 0),
      inFlightCalls: Number(broker.inFlightCalls ?? 0),
      persistenceHealthy:
        (broker.persistence as { healthy?: boolean } | undefined)?.healthy === true,
    },
    currentWorkspace: input.current ? { id: input.current.id, name: input.current.name } : null,
    workspaces: input.workspaces.slice(0, 50).map((w) => ({
      id: w.id,
      name: w.name,
      aliases: w.aliases?.slice(0, 4) ?? [],
    })),
    sessions: input.sessions.slice(0, 25).map((s) => ({
      state: s.state ?? 'unknown',
      workspaceName: s.workspaceName ?? 'Unbound',
      ready: s.workerStatus?.ready === true,
      active: Number(s.inFlight ?? 0),
      queued: s.queued === true,
    })),
    skills: input.skills.slice(0, 30).map((s) => ({
      id: s.id,
      name: s.name,
      policy: s.policy,
    })),
  };
}
