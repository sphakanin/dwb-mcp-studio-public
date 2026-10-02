import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EventLog } from './event-log.js';
import { writeTestBaseConfig } from './test-policy.js';
import { searchListHasActiveWork, WorkerSupervisor } from './worker-supervisor.js';

assert.equal(searchListHasActiveWork('No active searches.'), false);
assert.equal(
  searchListHasActiveWork(
    'Active Searches (2):\n\nSession: search_1\n  Status: ✅ COMPLETED\n\nSession: search_2\n  Status: TERMINATED',
  ),
  false,
);
assert.equal(
  searchListHasActiveWork(
    'Active Searches (2):\n\nSession: search_1\n  Status: ✅ COMPLETED\n\nSession: search_2\n  Status: 🔄 RUNNING',
  ),
  true,
);
assert.equal(searchListHasActiveWork('Active Searches (1):\n\nSession: search_unknown'), true);

const root = resolve('logs', 'worker-circuit');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
process.env.DWB_TELEMETRY_ENABLED = 'false';
process.env.DWB_EVENT_LOG_PATH = resolve(root, 'events.jsonl');
process.env.DWB_RUNTIME_DIR = resolve(root, 'runtime');
process.env.DWB_BASE_DC_CONFIG = await writeTestBaseConfig(root);
process.env.DWB_WORKER_ENTRY = resolve(root, 'does-not-exist.js');
process.env.DWB_WORKER_SPAWN_ATTEMPTS = '2';
process.env.DWB_WORKER_BACKOFF_BASE_MS = '60';
process.env.DWB_WORKER_BACKOFF_MAX_MS = '60';
process.env.DWB_WORKER_CIRCUIT_THRESHOLD = '2';
process.env.DWB_WORKER_CIRCUIT_COOLDOWN_MS = '1500';
const log = new EventLog(resolve(root, 'events.jsonl'));
const worker = new WorkerSupervisor(
  log,
  {
    sessionId: 'circuit-test',
    workspaceKey: root,
    workerId: 'worker-circuit-test',
  },
  60_000,
);

const firstStart = performance.now();
await assert.rejects(
  () => worker.start(),
  (error: any) => error?.name === 'WorkerCircuitOpenError',
);
const firstMs = performance.now() - firstStart;
const status = worker.status;
assert.equal(status.consecutiveStartFailures, 2);
assert.ok(status.circuitOpenUntil);
assert.ok(firstMs >= 40, `Expected backoff before opening circuit, got ${firstMs}ms`);

const secondStart = performance.now();
await assert.rejects(
  () => worker.restart('repeat-failure'),
  (error: any) => error?.name === 'WorkerCircuitOpenError',
);
const secondMs = performance.now() - secondStart;
assert.ok(secondMs < 120, `Open circuit should fail fast, got ${secondMs}ms`);
await worker.stop().catch(() => {});

console.log(
  'WORKER_CIRCUIT_PASS',
  JSON.stringify({
    firstMs: Math.round(firstMs),
    secondMs: Math.round(secondMs),
    failures: status.consecutiveStartFailures,
    circuitOpenUntil: status.circuitOpenUntil,
  }),
);
