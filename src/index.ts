import { Server } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { BrokerClient } from './broker-client.js';
import { resolveLogicalRequestContext } from './request-context.js';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let handle: StdioServerHandle | null = null;
let shuttingDown = false;
const brokers = new Set<BrokerClient>();

async function createServer() {
  const broker = await BrokerClient.connect(process.cwd());
  brokers.add(broker);

  const server = new Server(
    { name: 'dwb-mcp-studio-core', version },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'DWB Core manages isolated Desktop Commander workers. When the user specifies a working directory or project root, immediately call workspace with action="bind" and path set to that absolute directory before any file or shell work. This one call registers or reuses the exact workspace and binds it to this chat; do not ask the user to separately create a workspace or repeat the directory. Verify the returned workingDirectory. If only a known project name is given, bind using its workspace name or alias. If no directory or project is given, do not infer it from other chats or from a file merely being read. Binding changes this session worker CWD; existing active processes must finish before switching. It does not expand the configured filesystem policy. DWB Studio also provides workspace Agent Skills through the skills tool. After binding a workspace, when the user task may match an installed planning, testing, review, security, or other reusable workflow, call skills with action=list before improvising. Respect each effective policy: AUTO may be activated when useful; ASK must ask the user in chat and wait for an explicit yes in a later user turn before retrying activate with the returned approval_id and user_confirmed=true (the Studio UI may approve it too); MANUAL is only for an explicit user request. Never treat Skill approval as a substitute for filesystem or command safety controls. Use absolute paths for filesystem tools. Re-read and reconcile files when stale-write protection reports a conflict. A DWB session ID is not a ChatGPT conversation ID.',
    },
  );

  const contextOf = (ctx: any) =>
    resolveLogicalRequestContext(ctx?.mcpReq?._meta, ctx?.mcpReq?.envelope);

  server.setRequestHandler('tools/list', async (_request, ctx) =>
    broker.listTools(contextOf(ctx), ctx.mcpReq.signal),
  );
  server.setRequestHandler('tools/call', async (request, ctx) =>
    broker.callTool(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      contextOf(ctx),
      ctx.mcpReq.signal,
    ),
  );
  server.setRequestHandler('resources/list', async (_request, ctx) =>
    broker.listResources(contextOf(ctx), ctx.mcpReq.signal),
  );
  server.setRequestHandler('resources/templates/list', async (_request, ctx) =>
    broker.listResourceTemplates(contextOf(ctx), ctx.mcpReq.signal),
  );
  server.setRequestHandler('resources/read', async (request, ctx) =>
    broker.readResource(request.params.uri, contextOf(ctx), ctx.mcpReq.signal),
  );

  server.onclose = () => {
    brokers.delete(broker);
    void broker.close().catch(() => {});
  };
  return server;
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await handle?.close();
    await Promise.allSettled([...brokers].map((broker) => broker.close()));
  } finally {
    process.exit(code);
  }
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

function main(): void {
  handle = serveStdio(createServer, {
    legacy: 'serve',
    onerror: (error) => console.error('[dwb-desktop-adapter] protocol error:', error),
  });
}

main();
