import { chmod, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from '../atomic-write';
import type { InstallPaths } from './install-layout';

export interface LauncherSpec {
  nodePath: string;
  entryPath: string;
}

/** Writes stable entrypoints. Version selection remains an atomic install.json pointer. */
export class StableLauncher {
  constructor(
    private readonly paths: InstallPaths,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly nodePath = process.execPath,
  ) {}

  launchSpec(): LauncherSpec {
    return { nodePath: this.nodePath, entryPath: this.paths.launcherModuleFile };
  }

  async write(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.launcherDir, { recursive: true }),
      mkdir(this.paths.binRoot, { recursive: true }),
    ]);
    await writeFileAtomic(this.paths.launcherModuleFile, launcherSource(this.paths.stateFile), { mode: 0o755 });
    if (this.platform === 'win32') {
      await writeFileAtomic(this.paths.commandFile, windowsCommand(this.nodePath, this.paths.launcherModuleFile), { mode: 0o755 });
      return;
    }
    await writeFileAtomic(this.paths.commandFile, unixCommand(this.paths.launcherModuleFile), { mode: 0o755 });
    await chmod(this.paths.commandFile, 0o755);
  }
}

export function launcherSource(stateFile: string): string {
  return `import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const stateFile = ${JSON.stringify(stateFile)};
const state = JSON.parse(await readFile(stateFile, 'utf8'));
if (state?.schemaVersion !== 1 || !state.current?.entryPath) {
  throw new Error('Aria has no active installed version; run the installer or aria update rollback');
}
await import(pathToFileURL(state.current.entryPath).href);
`;
}

function unixCommand(launcherModuleFile: string): string {
  return `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(launcherModuleFile).href)};\n`;
}

function windowsCommand(nodePath: string, launcherModuleFile: string): string {
  return `@echo off\r\n"${escapeCmd(nodePath)}" "${escapeCmd(launcherModuleFile)}" %*\r\n`;
}

function escapeCmd(value: string): string {
  if (/[\r\n"]/u.test(value)) throw new Error('launcher path contains unsupported Windows command characters');
  return value.replaceAll('%', '%%');
}
