import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultWorkerShell } from './paths.js';

export async function writeTestBaseConfig(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, 'base-dc-config.json');
  const config = {
    blockedCommands: ['shutdown', 'reboot', 'format', 'diskpart'],
    defaultShell: defaultWorkerShell(),
    allowedDirectories: [],
    telemetryEnabled: false,
    fileWriteLineLimit: 50,
    fileReadLineLimit: 1000,
    pendingWelcomeOnboarding: false,
    welcomeOnboardingEligible: false,
  };
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
  return path;
}
