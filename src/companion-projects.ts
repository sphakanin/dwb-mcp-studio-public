import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathWithin } from './workspace-store.js';

export type ProjectHome = { id: string; name: string; directory: string };

export function safeProjectName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Enter a project name.');
  const name = raw.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(name) ||
    name.endsWith('.') ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name) ||
    ['node_modules', '.git', 'dist', 'runtime', 'data', 'logs'].includes(name.toLowerCase())
  ) {
    throw new Error(
      'Project name must be 1–60 letters, digits, hyphens, underscores or dots; not a reserved name.',
    );
  }
  return name;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() === true;
}

export async function allowedRoots(policyFile = process.env.DWB_BASE_DC_CONFIG): Promise<string[]> {
  if (!policyFile) return [];
  let config: any;
  try {
    config = JSON.parse(await readFile(resolve(policyFile), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(config.allowedDirectories)) return [];
  const unique = new Set<string>();
  for (const raw of config.allowedDirectories) {
    if (typeof raw !== 'string' || !isAbsolute(raw) || !(await isDirectory(raw))) continue;
    unique.add(await realpath(raw));
  }
  return [...unique];
}

export async function assertAllowedDirectory(path: string, roots: string[]): Promise<string> {
  if (!isAbsolute(path)) throw new Error('The selected folder must have an absolute path.');
  const target = await realpath(path).catch(() => {
    throw new Error('Folder does not exist or is not accessible.');
  });
  if (!(await isDirectory(target))) throw new Error('The selected path is not a directory.');
  if (!roots.some((root) => pathWithin(root, target)))
    throw new Error(
      'Folder is outside DWB allowedDirectories. Add it to your DWB Setup policy first.',
    );
  return target;
}

export async function projectHomes(roots: string[]): Promise<ProjectHome[]> {
  const homes: ProjectHome[] = [];
  for (const root of roots) {
    const directory = await realpath(root).catch(() => null);
    if (!directory || !(await isDirectory(directory))) continue;
    // A code repository is never an implicit parent for a new project.
    if (
      (await lstat(join(directory, '.git')).catch(() => null)) ||
      (await lstat(join(directory, 'package.json')).catch(() => null))
    )
      continue;
    homes.push({
      id: 'home_' + createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 16),
      name: basename(directory) || directory,
      directory,
    });
  }
  return homes.slice(0, 20);
}

export type ProjectKind = 'blank' | 'web' | 'docs';

function projectFiles(name: string, kind: ProjectKind): Record<string, string> {
  const readme = [
    '# ' + name,
    '',
    'Project created with DWB Companion.',
    '',
    '## Objective',
    '',
    'Describe the purpose, expected users and success criteria.',
    '',
  ].join('\n');
  if (kind === 'blank') return { 'README.md': readme };
  if (kind === 'docs')
    return {
      'README.md': readme,
      'PROJECT-BRIEF.md': '# Project Brief\n\n## Goal\n\n## Scope\n\n## Milestones\n\n',
    };
  return {
    'README.md': readme,
    'PROJECT-BRIEF.md': '# Website Brief\n\n## Audience\n\n## Pages\n\n## Design Direction\n\n',
    'index.html':
      '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
      name +
      '</title></head><body><main><h1>' +
      name +
      '</h1><p>Ready to build with ChatGPT + DWB.</p></main></body></html>\n',
  };
}

export async function createStarterProject(input: {
  homeId: string;
  projectName: unknown;
  kind: string;
  homes: ProjectHome[];
}): Promise<{ directory: string; name: string; kind: ProjectKind }> {
  const name = safeProjectName(input.projectName);
  const home = input.homes.find((entry) => entry.id === input.homeId);
  if (!home) throw new Error('Choose an approved project home in DWB.');
  const kind: ProjectKind = input.kind === 'web' || input.kind === 'docs' ? input.kind : 'blank';
  const actualHome = await realpath(home.directory);
  if (actualHome !== home.directory)
    throw new Error('Project home changed. Refresh and try again.');
  const directory = join(actualHome, name);
  if (!pathWithin(actualHome, directory)) throw new Error('Invalid project path.');
  // Non-recursive mkdir fails on collisions; never overwrite existing files.
  await mkdir(directory);
  const files = projectFiles(name, kind);
  for (const [relativeName, content] of Object.entries(files))
    await writeFile(join(directory, relativeName), content, { flag: 'wx' });
  return { directory, name, kind };
}
