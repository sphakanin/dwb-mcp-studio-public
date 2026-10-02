import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SkillStore } from './skill-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dwb-skills-'));
  const source = join(root, 'source', 'grilling');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, 'SKILL.md'),
    [
      '---',
      'name: grilling',
      'description: Clarify a plan before implementation.',
      '---',
      '',
      '# Grilling',
      'Ask the frontier, recommend an answer, and wait.',
    ].join('\n'),
  );
  await writeFile(join(source, 'guide.md'), '# Guide\nCompanion instructions.');
  const store = new SkillStore({
    dbPath: join(root, 'skills.db'),
    libraryRoot: join(root, 'library'),
  });
  return { root, source, store };
}

test('local install creates a managed copy and preserves companion files', async () => {
  const f = await fixture();
  try {
    const skill = await f.store.installLocal({ sourceDir: f.source });
    assert.equal(skill.id, 'grilling');
    assert.equal(skill.defaultPolicy, 'ask');
    assert.equal(skill.sourceType, 'local');
    assert.equal(skill.sourceRef, resolve(f.source));
    assert.notEqual(resolve(skill.installPath), resolve(f.source));
    assert.match(await readFile(join(skill.installPath, 'SKILL.md'), 'utf8'), /# Grilling/);
    assert.match(await f.store.readSkillFile('grilling', 'guide.md'), /Companion instructions/);
  } finally {
    f.store.close();
  }
});

test('workspace policy overrides the installed default', async () => {
  const f = await fixture();
  try {
    await f.store.installLocal({ sourceDir: f.source });
    await f.store.setWorkspacePolicy('ws_one', 'grilling', 'auto');
    assert.equal(f.store.get('grilling', 'ws_one')?.policy, 'auto');
    assert.equal(f.store.get('grilling', 'ws_two')?.policy, 'ask');
    assert.deepEqual(f.store.workspacePolicyOverrides('ws_one'), { grilling: 'auto' });
    assert.deepEqual(f.store.workspacePolicyOverrides('ws_two'), {});
  } finally {
    f.store.close();
  }
});

test('ASK policy cannot activate before a separately approved request', async () => {
  const f = await fixture();
  try {
    await f.store.installLocal({ sourceDir: f.source });
    const first = f.store.activate({
      sessionId: 'session-a',
      workspaceId: 'ws_one',
      skillId: 'grilling',
    });
    assert.equal(first.status, 'approval_required');
    assert.ok(first.approvalId);
    assert.equal(f.store.pendingApprovals().length, 1);

    f.store.decideApproval(first.approvalId!, 'approved');
    const second = f.store.activate({
      sessionId: 'session-a',
      workspaceId: 'ws_one',
      skillId: 'grilling',
      approvalId: first.approvalId,
    });
    assert.equal(second.status, 'active');
    assert.match(second.instructions ?? '', /Ask the frontier/);

    const replay = f.store.activate({
      sessionId: 'session-a',
      workspaceId: 'ws_one',
      skillId: 'grilling',
      approvalId: first.approvalId,
    });
    assert.equal(replay.status, 'approval_required');
  } finally {
    f.store.close();
  }
});

test('MANUAL policy activates only for explicit user intent', async () => {
  const f = await fixture();
  try {
    await f.store.installLocal({ sourceDir: f.source });
    await f.store.setWorkspacePolicy('ws_one', 'grilling', 'manual');
    assert.equal(
      f.store.activate({ sessionId: 's', workspaceId: 'ws_one', skillId: 'grilling' }).status,
      'manual_only',
    );
    const activated = f.store.activate({
      sessionId: 's',
      workspaceId: 'ws_one',
      skillId: 'grilling',
      explicitUserRequest: true,
    });
    assert.equal(activated.status, 'active');
  } finally {
    f.store.close();
  }
});

test('ASK policy can be confirmed from a later explicit user turn', async () => {
  const f = await fixture();
  try {
    await f.store.installLocal({ sourceDir: f.source });
    const first = f.store.activate({
      sessionId: 'session-chat',
      workspaceId: 'ws_one',
      skillId: 'grilling',
    });
    assert.equal(first.status, 'approval_required');

    const confirmed = f.store.activate({
      sessionId: 'session-chat',
      workspaceId: 'ws_one',
      skillId: 'grilling',
      approvalId: first.approvalId,
      userConfirmed: true,
    });
    assert.equal(confirmed.status, 'active');
    assert.match(confirmed.instructions ?? '', /Ask the frontier/);
    assert.equal(f.store.pendingApprovals().length, 0);
  } finally {
    f.store.close();
  }
});

for (const change of ['instructions', 'companion']) {
  test(
    'reinstall invalidates pending approvals, approved requests and leases: ' + change,
    async () => {
      const f = await fixture();
      try {
        const original = await f.store.installLocal({ sourceDir: f.source });
        await f.store.setWorkspacePolicy('ws_other', 'grilling', 'manual');
        const args = { sessionId: 'pending', workspaceId: 'ws_one', skillId: 'grilling' };
        const pending = f.store.activate(args);
        const approved = f.store.activate({ ...args, sessionId: 'approved' });
        f.store.decideApproval(approved.approvalId!, 'approved');
        const active = f.store.activate({ ...args, sessionId: 'active' });
        f.store.activate({
          ...args,
          sessionId: 'active',
          approvalId: active.approvalId,
          userConfirmed: true,
        });
        assert.equal(f.store.isActivated('active', 'ws_one', 'grilling'), true);
        if (change === 'instructions') {
          const path = join(f.source, 'SKILL.md');
          await writeFile(path, (await readFile(path, 'utf8')) + '\nUpdated instructions.');
        } else await writeFile(join(f.source, 'guide.md'), 'Updated companion.');
        const updated = await f.store.installLocal({ sourceDir: f.source });
        assert.notEqual(updated.installPath, original.installPath);
        assert.equal(updated.installedAt, original.installedAt);
        assert.equal(f.store.get('grilling', 'ws_other')?.policy, 'manual');
        assert.equal(f.store.pendingApprovals().length, 0);
        assert.equal(f.store.isActivated('active', 'ws_one', 'grilling'), false);
        await assert.rejects(
          f.store.readActivatedSkillFile('active', 'ws_one', 'grilling', 'guide.md'),
          /DWB_SKILL_NOT_ACTIVE/,
        );
        for (const [sessionId, request] of [
          ['pending', pending],
          ['approved', approved],
        ] as const) {
          const result = f.store.activate({
            ...args,
            sessionId,
            approvalId: request.approvalId,
            userConfirmed: true,
          });
          assert.equal(result.status, 'approval_required');
          assert.notEqual(result.approvalId, request.approvalId);
          assert.equal(result.instructions, undefined);
        }
      } finally {
        f.store.close();
      }
    },
  );
}

test('failed package validation preserves installed skill and activation', async () => {
  const f = await fixture();
  try {
    const original = await f.store.installLocal({ sourceDir: f.source, defaultPolicy: 'auto' });
    f.store.activate({ sessionId: 's', workspaceId: 'w', skillId: 'grilling' });
    await writeFile(join(f.source, 'oversized.bin'), Buffer.alloc(8 * 1024 * 1024));
    await assert.rejects(f.store.installLocal({ sourceDir: f.source }), /safety limit/);
    assert.equal(f.store.get('grilling')?.installPath, original.installPath);
    assert.match(
      await f.store.readActivatedSkillFile('s', 'w', 'grilling', 'guide.md'),
      /Companion/,
    );
  } finally {
    f.store.close();
  }
});

test('skill file pages round-trip UTF-8 and reject invalid ranges', async () => {
  const f = await fixture();
  try {
    const content = 'ภาษาไทย🙂\n'.repeat(2000);
    await writeFile(join(f.source, 'guide.md'), content);
    await f.store.installLocal({ sourceDir: f.source, defaultPolicy: 'auto' });
    await assert.rejects(
      f.store.readActivatedSkillPage('s', 'w', 'grilling', 'guide.md'),
      /DWB_SKILL_NOT_ACTIVE/,
    );
    f.store.activate({ sessionId: 's', workspaceId: 'w', skillId: 'grilling' });
    let offset: number | null = 0;
    let combined = '';
    while (offset !== null) {
      const page = await f.store.readActivatedSkillPage(
        's',
        'w',
        'grilling',
        'guide.md',
        offset,
        101,
      );
      assert.ok(Buffer.byteLength(page.content) <= 101);
      combined += page.content;
      offset = page.nextOffset;
    }
    assert.equal(combined, content);
    for (const [offset, length] of [
      [-1, 10],
      [0, 0],
      [0, 65537],
      [0, 1.5],
      [1, 10],
      [999999, 10],
    ]) {
      await assert.rejects(
        f.store.readActivatedSkillPage('s', 'w', 'grilling', 'guide.md', offset, length),
      );
    }
    const eof = await f.store.readActivatedSkillPage(
      's',
      'w',
      'grilling',
      'guide.md',
      Buffer.byteLength(content),
    );
    assert.equal(eof.content, '');
    assert.equal(eof.nextOffset, null);
  } finally {
    f.store.close();
  }
});

test('competing installs from two stores publish a complete package and preserve policy', async () => {
  const f = await fixture();
  const other = new SkillStore({
    dbPath: join(f.root, 'skills.db'),
    libraryRoot: join(f.root, 'library'),
  });
  try {
    await f.store.installLocal({ sourceDir: f.source });
    await f.store.setWorkspacePolicy('w', 'grilling', 'manual');
    const second = join(f.root, 'second');
    await mkdir(second);
    await writeFile(
      join(second, 'SKILL.md'),
      (await readFile(join(f.source, 'SKILL.md'), 'utf8')) + '\nSecond version',
    );
    await writeFile(join(second, 'guide.md'), 'Second guide');
    await Promise.all([
      f.store.installLocal({ sourceDir: f.source }),
      other.installLocal({ sourceDir: second }),
    ]);
    const current = f.store.get('grilling', 'w')!;
    assert.equal(current.policy, 'manual');
    const instructions = await readFile(join(current.installPath, 'SKILL.md'), 'utf8');
    const guide = await readFile(join(current.installPath, 'guide.md'), 'utf8');
    assert.equal(instructions.includes('Second version'), guide === 'Second guide');
    assert.equal(other.get('grilling')?.installPath, current.installPath);
  } finally {
    other.close();
    f.store.close();
  }
});

test('uninstall during an outstanding file read does not return revoked content', async () => {
  const f = await fixture();
  try {
    await f.store.installLocal({ sourceDir: f.source, defaultPolicy: 'auto' });
    f.store.activate({ sessionId: 's', workspaceId: 'w', skillId: 'grilling' });
    let finish!: (value: string) => void;
    f.store.readSkillFile = async () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      });
    const pending = f.store.readActivatedSkillFile('s', 'w', 'grilling', 'guide.md');
    const rejected = assert.rejects(pending, /DWB_SKILL_NOT_ACTIVE/);
    await f.store.uninstall('grilling');
    finish('Old content');
    await rejected;
  } finally {
    f.store.close();
  }
});

test('reopening the registry preserves package, policies, pending consent and active lease', async () => {
  const f = await fixture();
  await f.store.installLocal({ sourceDir: f.source, defaultPolicy: 'manual' });
  await f.store.setWorkspacePolicy('w', 'grilling', 'ask');
  const args = { sessionId: 's', workspaceId: 'w', skillId: 'grilling' };
  const request = f.store.activate(args);
  f.store.close();
  const reopened = new SkillStore({
    dbPath: join(f.root, 'skills.db'),
    libraryRoot: join(f.root, 'library'),
  });
  try {
    assert.equal(reopened.get('grilling')?.defaultPolicy, 'manual');
    assert.equal(reopened.get('grilling', 'w')?.policy, 'ask');
    assert.equal(reopened.pendingApprovals()[0].id, request.approvalId);
    assert.equal(
      reopened.activate({ ...args, approvalId: request.approvalId, userConfirmed: true }).status,
      'active',
    );
  } finally {
    reopened.close();
  }
  const again = new SkillStore({
    dbPath: join(f.root, 'skills.db'),
    libraryRoot: join(f.root, 'library'),
  });
  try {
    assert.match(await again.readActivatedSkillFile('s', 'w', 'grilling', 'guide.md'), /Companion/);
  } finally {
    again.close();
  }
});
