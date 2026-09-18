import { chmod, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from '../atomic-write';
import { currentRuntime, type RuntimeKind } from '../runtime';
import type { InstallPaths } from './install-layout';

export interface LauncherSpec {
  /** JS runtime executable (node or bun) used by generated launchers. */
  runtimePath: string;
  entryPath: string;
}

/** Writes stable entrypoints. Version selection remains an atomic install.json pointer. */
export class StableLauncher {
  constructor(
    private readonly paths: InstallPaths,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly runtimePath = currentRuntime.execPath,
    private readonly runtimeKind: RuntimeKind = currentRuntime.kind,
  ) {}

  launchSpec(): LauncherSpec {
    return { runtimePath: this.runtimePath, entryPath: this.paths.launcherModuleFile };
  }

  async write(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.launcherDir, { recursive: true }),
      mkdir(this.paths.binRoot, { recursive: true }),
    ]);
    await writeFileAtomic(this.paths.launcherModuleFile, launcherSource(this.paths.stateFile), { mode: 0o755 });
    if (this.platform === 'win32') {
      await writeFileAtomic(this.paths.commandFile, windowsCommand(this.runtimePath, this.paths.launcherModuleFile), { mode: 0o755 });
      return;
    }
    await writeFileAtomic(this.paths.commandFile, unixCommand(this.paths.launcherModuleFile, this.runtimeKind), { mode: 0o755 });
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

function unixCommand(launcherModuleFile: string, kind: RuntimeKind = 'node'): string {
  return `#!/usr/bin/env ${kind === 'bun' ? 'bun' : 'node'}\nimport ${JSON.stringify(pathToFileURL(launcherModuleFile).href)};\n`;
}

function windowsCommand(runtimePath: string, launcherModuleFile: string): string {
  return `@echo off\r\n"${escapeCmd(runtimePath)}" "${escapeCmd(launcherModuleFile)}" %*\r\n`;
}

function escapeCmd(value: string): string {
  if (/[\r\n"]/u.test(value)) throw new Error('launcher path contains unsupported Windows command characters');
  return value.replaceAll('%', '%%');
}
