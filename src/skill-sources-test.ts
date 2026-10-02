import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installGitHubSkill, RECOMMENDED_SKILLS, parseGitHubSkillUrl } from './skill-sources.js';
import { SkillStore } from './skill-store.js';

test('GitHub repository URL defaults to HEAD and auto-discovery', () => {
  assert.deepEqual(parseGitHubSkillUrl('https://github.com/mikehasa/golive-skill'), {
    owner: 'mikehasa',
    repo: 'golive-skill',
    ref: 'HEAD',
    path: undefined,
    repository: 'https://github.com/mikehasa/golive-skill',
  });
});

test('GitHub tree URL preserves pinned ref and skill path', () => {
  assert.deepEqual(
    parseGitHubSkillUrl(
      'https://github.com/mikehasa/golive-skill/tree/v0.1.0-alpha.5/skills/golive',
    ),
    {
      owner: 'mikehasa',
      repo: 'golive-skill',
      ref: 'v0.1.0-alpha.5',
      path: 'skills/golive',
      repository: 'https://github.com/mikehasa/golive-skill',
    },
  );
});
test('GitHub URL supports explicit ref and path query parameters', () => {
  const parsed = parseGitHubSkillUrl(
    'https://github.com/example/skills?ref=release-1&path=skills/demo',
  );
  assert.equal(parsed.ref, 'release-1');
  assert.equal(parsed.path, 'skills/demo');
});

test('remote source parser rejects unsupported hosts and traversal', () => {
  assert.throws(
    () => parseGitHubSkillUrl('https://example.com/owner/repo'),
    /Only https:\/\/github\.com/,
  );
  assert.throws(
    () => parseGitHubSkillUrl('https://github.com/owner/repo?path=../secret'),
    /stay inside the repository/,
  );
});

test('recommended catalog pins GoLive to ASK and a concrete release', () => {
  const golive = RECOMMENDED_SKILLS.find((item) => item.id === 'golive');
  assert.ok(golive);
  assert.equal(golive.defaultPolicy, 'ask');
  assert.match(golive.ref, /^v\d/);
  assert.equal(golive.verify?.expectedVersion, golive.version);
});

test('recommended catalog pins BRAG Slim to MANUAL and an immutable commit', () => {
  const brag = RECOMMENDED_SKILLS.find((item) => item.id === 'brag-slim');
  assert.ok(brag);
  assert.equal(brag.defaultPolicy, 'manual');
  assert.equal(brag.path, 'skills/brag-slim');
  assert.match(brag.ref, /^[0-9a-f]{40}$/);
  assert.equal(brag.version, '0.4.0');
});

test('GitHub installer fetches only the selected skill directory', async () => {
  const ref = '1111111111111111111111111111111111111111';
  const skillText = '---\nname: demo\ndescription: targeted download test\n---\n\n# Demo\n';
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  const temp = await mkdtemp(join(tmpdir(), 'dwb-skill-source-test-'));
  const store = new SkillStore({
    dbPath: join(temp, 'skills.db'),
    libraryRoot: join(temp, 'skills'),
  });

  globalThis.fetch = (async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith(`/commits/${ref}`))
      return json({ sha: ref, commit: { tree: { sha: 'root-tree' } } });
    if (url.endsWith('/git/trees/root-tree'))
      return json({
        sha: 'root-tree',
        tree: [{ path: 'skills', mode: '040000', type: 'tree', sha: 'skills-tree' }],
      });
    if (url.endsWith('/git/trees/skills-tree'))
      return json({
        sha: 'skills-tree',
        tree: [{ path: 'demo', mode: '040000', type: 'tree', sha: 'demo-tree' }],
      });
    if (url.endsWith('/git/trees/demo-tree?recursive=1'))
      return json({
        sha: 'demo-tree',
        tree: [
          {
            path: 'SKILL.md',
            mode: '100644',
            type: 'blob',
            sha: 'skill-blob',
            size: Buffer.byteLength(skillText),
          },
        ],
      });
    if (url.includes('raw.githubusercontent.com/example/skills/'))
      return new Response(skillText, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  try {
    const installed = await installGitHubSkill(
      store,
      `https://github.com/example/skills/tree/${ref}/skills/demo`,
      { defaultPolicy: 'manual', expectedId: 'demo' },
    );
    assert.equal(installed.id, 'demo');
    assert.equal(installed.defaultPolicy, 'manual');
    assert.equal(installed.sourceRef, `https://github.com/example/skills/tree/${ref}/skills/demo`);
    assert.equal(
      requested.some((url) => url.includes('codeload.github.com')),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    await rm(temp, { recursive: true, force: true });
  }
});
