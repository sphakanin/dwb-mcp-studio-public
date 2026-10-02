// Returned by controlTool when the name is not a broker control tool, so a
// control tool that legitimately returns a falsy result is not mistaken for
// "unhandled" and forwarded to the Desktop Commander worker.
export const NOT_A_CONTROL_TOOL = Symbol('dwb.notAControlTool');

export const brokerTools = [
  {
    name: 'dwb_bridge_status',
    description: 'Show singleton DWB broker health plus the current MCP session.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dwb_broker_status',
    description: 'Show global DWB broker, worker-pool, queue and lock status.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dwb_session_status',
    description: 'Show the current MCP session and sticky Desktop Commander worker status.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dwb_restart_worker',
    description: 'Restart only the current MCP session Desktop Commander worker.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'dwb_list_sessions',
    description: 'List all attached and detached local MCP sessions known to the broker.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dwb_list_detached_sessions',
    description: 'List detached sessions that may be resumed after a chat/context disconnect.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dwb_resume_session',
    description: 'Replace the current fresh MCP session with a detached DWB session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Detached DWB session ID to resume.' },
      },
      required: ['session_id'],
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'skills',
    description:
      'Manage and use DWB Studio Agent Skills. Call action=list for installed skills or catalog for curated recommendations. AUTO skills may be activated when useful. ASK skills require a separate user approval before instructions are returned. MANUAL skills may be activated only when the user explicitly asks for that skill or capability. Local installs are limited to the bound workspace. Remote GitHub/recommended installs are allowed only after an explicit user request.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'Skill operation: list, catalog, install_local, install_github, install_recommended, set_default_policy, set_workspace_policy, clear_workspace_policy, activate, read_file.',
        },
        skill: { type: 'string', description: 'Installed skill ID/name.' },
        path: { type: 'string', description: 'Local skill directory for install_local.' },
        github_url: {
          type: 'string',
          description:
            'HTTPS GitHub repository or /tree/<ref>/<skill-path> URL for install_github.',
        },
        policy: { type: 'string', description: 'auto, ask, or manual.' },
        approval_id: { type: 'string', description: 'Approval request returned by activate.' },
        relative_path: {
          type: 'string',
          description:
            'File path inside an active skill, including SKILL.md. Read successive pages using nextOffset until null.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description:
            'UTF-8 byte offset for read_file; defaults to 0. Use the returned nextOffset.',
        },
        length: {
          type: 'integer',
          minimum: 4,
          maximum: 65536,
          description:
            'Maximum bytes per read_file page; defaults to 8192. Reduce if the payload guard limits a response.',
        },
        explicit_user_request: {
          type: 'boolean',
          description:
            'True only when the current user request explicitly asks for this skill/capability or explicitly requests a remote Skill install.',
        },
        user_confirmed: {
          type: 'boolean',
          description:
            'For ASK policy only: true only after this approval_id was returned and the user explicitly confirmed using the Skill in a later user turn.',
        },
      },
      required: ['action'],
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'workspace',
    description:
      'When the user gives a working directory, immediately call action=bind with path=<absolute directory>. This registers or reuses that exact folder and binds it to this chat in one step, without asking the user to create a workspace separately. The worker starts in the bound directory; an idle worker is replaced on directory changes. Other chats keep their bindings. This does not expand filesystem policy. Do not infer the workspace from arbitrary file paths.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Workspace operation: list, status, register, bind, resolve, unbind.',
        },
        workspace: { type: 'string', description: 'Workspace ID, name, alias, or absolute path.' },
        workspace_id: { type: 'string' },
        query: { type: 'string' },
        path: { type: 'string' },
        root: { type: 'string' },
        name: { type: 'string' },
        aliases: { type: 'array', items: { type: 'string' } },
      },
      required: ['action'],
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
] as const;

export function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}
