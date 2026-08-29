import { homedir } from 'node:os';
import { join } from 'node:path';

export interface InstallPathApi {
  join(...paths: string[]): string;
}

export interface ResolveInstallPathsOptions {
  installRoot?: string;
  binRoot?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  pathApi?: InstallPathApi;
}

export interface InstallPaths {
  root: string;
  binRoot: string;
  downloadsDir: string;
  stagingDir: string;
  versionsDir: string;
  plansDir: string;
  operationsDir: string;
  launcherDir: string;
  launcherModuleFile: string;
  commandFile: string;
  stateFile: string;
  lockFile: string;
}

/** Resolve machine-level CLI installation paths without touching profile state. */
export function resolveInstallPaths(options: ResolveInstallPathsOptions = {}): InstallPaths {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const joinPath = options.pathApi?.join ?? join;
  const root = options.installRoot ?? env.ARIA_INSTALL_HOME ?? defaultInstallRoot({ env, home, platform, joinPath });
  const binRoot = options.binRoot ?? env.ARIA_BIN_HOME ?? defaultBinRoot({ env, home, platform, root, joinPath });
  const launcherDir = joinPath(root, 'bin');
  return {
    root,
    binRoot,
    downloadsDir: joinPath(root, 'downloads'),
    stagingDir: joinPath(root, 'staging'),
    versionsDir: joinPath(root, 'versions'),
    plansDir: joinPath(root, 'plans'),
    operationsDir: joinPath(root, 'operations'),
    launcherDir,
    launcherModuleFile: joinPath(launcherDir, 'launcher.mjs'),
    commandFile: joinPath(binRoot, platform === 'win32' ? 'aria.cmd' : 'aria'),
    stateFile: joinPath(root, 'install.json'),
    lockFile: joinPath(root, 'update.lock'),
  };
}

function defaultInstallRoot(input: {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  joinPath: (...paths: string[]) => string;
}): string {
  if (input.platform === 'win32') {
    return input.joinPath(input.env.LOCALAPPDATA ?? input.joinPath(input.home, 'AppData', 'Local'), 'Aria', 'cli');
  }
  if (input.platform === 'darwin') {
    return input.joinPath(input.home, 'Library', 'Application Support', 'Aria', 'cli');
  }
  return input.joinPath(input.env.XDG_DATA_HOME ?? input.joinPath(input.home, '.local', 'share'), 'aria', 'cli');
}

function defaultBinRoot(input: {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  root: string;
  joinPath: (...paths: string[]) => string;
}): string {
  if (input.platform === 'win32') return input.joinPath(input.root, 'bin');
  return input.env.XDG_BIN_HOME ?? input.joinPath(input.home, '.local', 'bin');
}
