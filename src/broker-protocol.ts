import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { dataDir } from './paths.js';
import { resolve } from 'node:path';

export const BROKER_PROTOCOL_VERSION = 1;

export function brokerEndpoint(): string {
  if (process.env.DWB_BROKER_PIPE) return process.env.DWB_BROKER_PIPE;
  const directory = dataDir();
  const identity = `${userInfo().username}:${process.platform === 'win32' ? directory.toLowerCase() : directory}`;
  const id = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  if (process.platform === 'win32') return `\\\\.\\pipe\\dwb-mcp-studio-core-v1-${id}`;
  // A GUI app and a terminal can inherit different TMPDIR values. Use one short,
  // per-user location so both transports still find the same singleton broker.
  return resolve('/tmp', `dwb-mcp-${userInfo().uid}`, `dwb-mcp-studio-core-${id}.sock`);
}

export type BrokerLogicalContext = {
  key: string;
  source: string;
  preview?: string;
  metaKeys?: string[];
};

export type BrokerRequest = {
  id: string;
  method:
    | 'hello'
    | 'list_tools'
    | 'call_tool'
    | 'list_resources'
    | 'list_resource_templates'
    | 'read_resource'
    | 'ping'
    | 'inspect'
    | 'shutdown'
    | 'cancel'
    | 'prepare_upgrade';
  deadline?: number;
  params?: Record<string, unknown>;
};

export type BrokerResponse = {
  id: string;
  ok: boolean;
  // Current transport root after operations such as resume; not an upstream tool result.
  sessionId?: string;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
};
