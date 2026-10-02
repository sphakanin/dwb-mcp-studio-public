import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SkillPolicy, SkillStore, SkillView } from './skill-store.js';

export type RecommendedSkill = {
  id: string;
  name: string;
  description: string;
  repository: string;
  ref: string;
  path: string;
  version: string;
  license: string;
  defaultPolicy: SkillPolicy;
  verify?: {
    script: string;
    args: string[];
    expectedVersion?: string;
  };
};

export const RECOMMENDED_SKILLS: RecommendedSkill[] = [
  {
    id: 'golive',
    name: 'GoLive',
    description:
      'เอาแอปที่ AI สร้างขึ้นออนไลน์ โดยใช้บัญชีของผู้ใช้เองและมี approval ก่อนเปลี่ยน production',
    repository: 'https://github.com/mikehasa/golive-skill',
    ref: 'v0.1.0-alpha.5',
    path: 'skills/golive',
    version: '0.1.0-alpha.5',
    license: 'MIT',
    defaultPolicy: 'ask',
    verify: {
      script: 'scripts/golive.mjs',
      args: ['version', '--json'],
      expectedVersion: '0.1.0-alpha.5',
    },
  },
  {
    id: 'brag-slim',
    name: 'BRAG Slim',
    description:
      'เปลี่ยนโปรเจกต์หรือเว็บไซต์เป็น launch video สั้น พร้อม poster และ share copy โดยใช้เครื่องมือที่มีในเครื่อง',
    repository: 'https://github.com/latent-spaces/brag',
    ref: 'c893c5ed52aed84e3e2ee56787de869fccdae6b0',
    path: 'skills/brag-slim',
    version: '0.4.0',
    license: 'MIT',
    defaultPolicy: 'manual',
  },
];

type ParsedGitHub = {
  owner: string;
  repo: string;
  ref: string;
  path?: string;
  repository: string;
};

function safeRelativePath(value?: string) {
  if (!value) return undefined;
  const clean = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean || clean.split('/').some((part) => part === '..' || part === '.'))
    throw new Error('GitHub skill path must stay inside the repository.');
  return clean;
}
export function parseGitHubSkillUrl(input: string): ParsedGitHub {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a valid GitHub URL.');
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com')
    throw new Error('Only https://github.com URLs are supported.');

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('GitHub URL must include owner and repository.');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error('Invalid GitHub owner or repository name.');

  let ref = url.searchParams.get('ref') || 'HEAD';
  let path = safeRelativePath(url.searchParams.get('path') || undefined);
  if (parts[2] === 'tree') {
    if (!parts[3]) throw new Error('GitHub tree URL is missing a ref.');
    ref = decodeURIComponent(parts[3]);
    path = safeRelativePath(parts.slice(4).join('/')) || path;
  } else if (parts.length > 2) {
    throw new Error('Use a repository URL or /tree/<ref>/<skill-path> URL.');
  }
  if (!ref.trim() || ref.includes('..')) throw new Error('Invalid GitHub ref.');
  return { owner, repo, ref, path, repository: `https://github.com/${owner}/${repo}` };
}

type GitHubTreeEntry = {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
};

type GitHubTree = {
  sha: string;
  tree: GitHubTreeEntry[];
  truncated?: boolean;
};

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DWB-MCP-Studio',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function resolveGitHubCommit(source: ParsedGitHub) {
  const ref = encodeURIComponent(source.ref);
  const payload = await githubJson<{
    sha?: string;
    commit?: { tree?: { sha?: string } };
  }>(`https://api.github.com/repos/${source.owner}/${source.repo}/commits/${ref}`);
  const commitSha = payload.sha;
  const rootTreeSha = payload.commit?.tree?.sha;
  if (!commitSha || !rootTreeSha) throw new Error('GitHub did not return a commit tree.');
  return { commitSha, rootTreeSha };
}

async function readGitHubTree(source: ParsedGitHub, treeSha: string, recursive = false) {
  return githubJson<GitHubTree>(
    `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`,
  );
}

async function treeAtPath(source: ParsedGitHub, rootTreeSha: string, pathHint: string) {
  let treeSha = rootTreeSha;
  for (const part of pathHint.split('/')) {
    const tree = await readGitHubTree(source, treeSha);
    const entry = tree.tree.find((item) => item.path === part);
    if (!entry) throw new Error(`GitHub skill path does not exist: ${pathHint}`);
    if (entry.mode === '120000' || entry.type !== 'tree')
      throw new Error(`GitHub skill path is not a regular directory: ${pathHint}`);
    treeSha = entry.sha;
  }
  return treeSha;
}

function skillMatches(tree: GitHubTree) {
  return tree.tree
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        entry.mode !== '120000' &&
        (entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md')) &&
        !entry.path.split('/').includes('node_modules') &&
        entry.path.split('/').length <= 7,
    )
    .map((entry) => (entry.path === 'SKILL.md' ? '' : entry.path.slice(0, -'/SKILL.md'.length)));
}

async function resolveRemoteSkill(
  source: ParsedGitHub,
  rootTreeSha: string,
): Promise<{ skillPath: string; tree: GitHubTree }> {
  if (source.path) {
    const treeSha = await treeAtPath(source, rootTreeSha, source.path);
    const tree = await readGitHubTree(source, treeSha, true);
    if (tree.truncated) throw new Error('GitHub skill tree is too large to inspect safely.');
    if (!tree.tree.some((entry) => entry.path === 'SKILL.md' && entry.type === 'blob'))
      throw new Error(`No SKILL.md found at repository path: ${source.path}`);
    return { skillPath: source.path, tree };
  }

  const repositoryTree = await readGitHubTree(source, rootTreeSha, true);
  if (repositoryTree.truncated)
    throw new Error(
      'GitHub repository tree is too large to auto-discover safely. Use a /tree/<ref>/<skill-path> URL or ?path=...',
    );
  const matches = skillMatches(repositoryTree);
  if (matches.length === 0) throw new Error('No SKILL.md found in this GitHub repository.');
  if (matches.length > 1) {
    const preview = matches
      .slice(0, 5)
      .map((item) => item || '.')
      .join(', ');
    throw new Error(
      `Multiple skills found (${preview}). Use a GitHub /tree/<ref>/<skill-path> URL or ?path=...`,
    );
  }

  const skillPath = matches[0];
  if (!skillPath) return { skillPath, tree: repositoryTree };
  const entry = repositoryTree.tree.find((item) => item.type === 'tree' && item.path === skillPath);
  if (!entry) throw new Error(`Cannot resolve GitHub skill directory: ${skillPath}`);
  const tree = await readGitHubTree(source, entry.sha, true);
  if (tree.truncated) throw new Error('GitHub skill tree is too large to inspect safely.');
  return { skillPath, tree };
}

function rawGitHubUrl(source: ParsedGitHub, commitSha: string, path: string) {
  const encoded = path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${commitSha}/${encoded}`;
}

async function downloadSkillFiles(
  source: ParsedGitHub,
  commitSha: string,
  skillPath: string,
  tree: GitHubTree,
  destination: string,
) {
  if (tree.tree.some((entry) => entry.mode === '120000' || entry.type === 'commit'))
    throw new Error('Skill packages may not contain symbolic links or submodules.');

  const files = tree.tree.filter((entry) => entry.type === 'blob');
  const declaredBytes = files.reduce((sum, entry) => sum + (entry.size || 0), 0);
  if (files.length > 512 || declaredBytes > 8 * 1024 * 1024)
    throw new Error('Skill package exceeds the V1 safety limit (512 files / 8 MiB).');

  let downloadedBytes = 0;
  for (const entry of files) {
    const repositoryPath = [skillPath, entry.path].filter(Boolean).join('/');
    const response = await fetch(rawGitHubUrl(source, commitSha, repositoryPath), {
      redirect: 'follow',
      headers: { 'User-Agent': 'DWB-MCP-Studio' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`GitHub file download failed for ${repositoryPath}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    downloadedBytes += bytes.length;
    if (downloadedBytes > 8 * 1024 * 1024)
      throw new Error('Skill package exceeds the V1 safety limit (512 files / 8 MiB).');
    const target = join(destination, ...entry.path.split('/'));
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, bytes);
  }
}

function sourceRef(source: ParsedGitHub, skillPath: string) {
  return skillPath
    ? `${source.repository}/tree/${source.ref}/${skillPath}`
    : `${source.repository}/tree/${source.ref}`;
}

async function declaredSkillId(skillDir: string) {
  const raw = (await readFile(join(skillDir, 'SKILL.md'), 'utf8')).replace(/\r\n/g, '\n');
  const end = raw.indexOf('\n---', 4);
  if (!raw.startsWith('---\n') || end < 0) return null;
  const line = raw
    .slice(4, end)
    .split('\n')
    .find((item) => /^name\s*:/.test(item));
  return line
    ? line
        .replace(/^name\s*:\s*/, '')
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .toLocaleLowerCase()
    : null;
}

export async function installGitHubSkill(
  store: SkillStore,
  input: string,
  options: {
    defaultPolicy?: SkillPolicy;
    expectedId?: string;
    beforeInstall?: (skillDir: string) => void | Promise<void>;
  } = {},
): Promise<SkillView> {
  const source = parseGitHubSkillUrl(input);
  const temp = await mkdtemp(join(tmpdir(), 'dwb-skill-github-'));
  try {
    const skillDir = join(temp, 'skill');
    const { commitSha, rootTreeSha } = await resolveGitHubCommit(source);
    const resolved = await resolveRemoteSkill(source, rootTreeSha);
    await mkdir(skillDir, { recursive: true });
    await downloadSkillFiles(source, commitSha, resolved.skillPath, resolved.tree, skillDir);
    if (options.expectedId) {
      const declared = await declaredSkillId(skillDir);
      if (declared !== options.expectedId)
        throw new Error(
          `Downloaded skill id "${declared || 'unknown'}" does not match expected id "${options.expectedId}".`,
        );
    }
    await options.beforeInstall?.(skillDir);
    const installed = await store.installLocal({
      sourceDir: skillDir,
      defaultPolicy: options.defaultPolicy,
      sourceType: 'github',
      sourceRef: sourceRef(source, resolved.skillPath),
    });
    return installed;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function installRecommendedSkill(store: SkillStore, id: string) {
  const item = RECOMMENDED_SKILLS.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown recommended skill: ${id}`);
  const url = `${item.repository}/tree/${item.ref}/${item.path}`;
  return installGitHubSkill(store, url, {
    defaultPolicy: item.defaultPolicy,
    expectedId: item.id,
    beforeInstall: item.verify
      ? (skillDir) => {
          const verify = spawnSync(
            process.execPath,
            [join(skillDir, item.verify!.script), ...item.verify!.args],
            { encoding: 'utf8', windowsHide: true },
          );
          if (verify.status !== 0)
            throw new Error(
              'Recommended skill verification failed: ' + (verify.stderr || verify.stdout).trim(),
            );
          if (!item.verify!.expectedVersion) return;
          const parsed = JSON.parse(verify.stdout);
          if (parsed.version !== item.verify!.expectedVersion)
            throw new Error(
              `Recommended skill version verification failed: expected ${item.verify!.expectedVersion}, got ${parsed.version || 'unknown'}`,
            );
        }
      : undefined,
  });
}
