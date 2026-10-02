import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Dedicated data and endpoint: no real Studio runtime or worker is touched.
const root = await mkdtemp(join(tmpdir(), 'dwb-skill-broker-'));
Object.assign(process.env, {
  DWB_DATA_DIR: join(root, 'data'),
  DWB_RUNTIME_DIR: join(root, 'runtime'),
  DWB_WORKSPACE_DB: join(root, 'workspaces.db'),
  DWB_BROKER_STATE_PATH: join(root, 'broker-state.json'),
  DWB_EVENT_LOG_PATH: join(root, 'events.jsonl'),
  DWB_BROKER_PIPE:
    process.platform === 'win32'
      ? '\\\\.\\pipe\\dwb-skill-test-' + randomUUID()
      : join(tmpdir(), 'dwb-skill-' + randomUUID() + '.sock'),
  DWB_BROKER_ALLOW_SHUTDOWN: 'true',
  DWB_BROKER_AUTOSTART: 'true',
  DWB_PAYLOAD_GUARD_ENABLED: 'true',
  DWB_PAYLOAD_MAX_BYTES: '262144',
  DWB_PAYLOAD_ARCHIVE: 'false',
});
const { BrokerClient } = await import('./broker-client.js');
const source = join(root, 'source');
await mkdir(source);
const instructions =
  '---\nname: broker-skill\ndescription: Payload regression fixture.\n---\n' +
  'instructions '.repeat(50000);
const guide = 'ภาษาไทย🙂\n'.repeat(40000);
await writeFile(join(source, 'SKILL.md'), instructions);
await writeFile(join(source, 'guide.md'), guide);
await writeFile(join(source, 'escaped.md'), '\0'.repeat(65536));
const client = await BrokerClient.connect(root);
const call = (args: Record<string, unknown>) => client.callTool('skills', args);
try {
  await client.callTool('workspace', { action: 'bind', path: root });
  const catalog = await call({ action: 'catalog' });
  assert.ok(
    Array.isArray(catalog.structuredContent?.skills) &&
      catalog.structuredContent.skills.some((item: any) => item.id === 'golive'),
  );
  await assert.rejects(
    call({ action: 'install_github', github_url: 'https://github.com/mikehasa/golive-skill' }),
    /DWB_SKILL_REMOTE_INSTALL_REQUIRES_USER_REQUEST/,
  );
  await call({ action: 'install_local', path: source, policy: 'auto' });
  const active = await call({ action: 'activate', skill: 'broker-skill' });
  assert.ok(Buffer.byteLength(JSON.stringify(active)) <= 262144);
  assert.equal(active._meta?.['dwb/payload_guard']?.guarded, true);
  const escaped = await call({
    action: 'read_file',
    skill: 'broker-skill',
    relative_path: 'escaped.md',
    length: 65536,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) <= 262144);
  assert.equal(escaped._meta?.['dwb/payload_guard']?.guarded, true);
  // Even when activation instructions are guarded, all instructions can be read in pages.
  for (const [file, expected] of [
    ['guide.md', guide],
    ['SKILL.md', instructions],
  ]) {
    let offset: number | null = 0;
    let combined = '';
    while (offset !== null) {
      const response = await call({
        action: 'read_file',
        skill: 'broker-skill',
        relative_path: file,
        offset,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 262144);
      assert.notEqual(response.isError, true);
      const page = response.structuredContent;
      assert.equal(page.offset, offset);
      combined += page.content;
      offset = page.nextOffset;
    }
    assert.equal(combined, expected);
  }
  await assert.rejects(
    call({ action: 'read_file', skill: 'broker-skill', relative_path: 'guide.md', length: '8192' }),
    /must be a number/,
  );
  await call({ action: 'install_local', path: source });
  await assert.rejects(
    call({ action: 'read_file', skill: 'broker-skill', relative_path: 'guide.md' }),
    /DWB_SKILL_NOT_ACTIVE/,
  );
  console.log(
    'SKILL_BROKER_PASS: guarded activation, bounded UTF-8 pages, complete instructions, revoked lease',
  );
} finally {
  try {
    await client.shutdownForTests();
  } finally {
    await client.close();
  }
}
