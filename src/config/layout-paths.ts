import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PathJoiner {
  join(...paths: string[]): string;
}

export interface AriaRoots {
  stateRoot: string;
  workspaceRoot: string;
}

export interface ResolveAriaRootsOptions {
  stateRoot?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  pathApi?: PathJoiner;
}

export interface RootPaths {
  root: string;
  configFile: string;
  activeProfileFile: string;
  layoutFile: string;
  helpersDir: string;
  profilesDir: string;
  hostDir: string;
  trashDir: string;
}

export interface ProfileIdentityPaths {
  root: string;
  secretsFile: string;
  keystoreSaltFile: string;
  larkCliSourceDir: string;
  larkCliDir: string;
}

export interface ProfileStatePaths {
  root: string;
  sessionsFile: string;
  sessionCatalogFile: string;
  workspacesFile: string;
  nativeReadDir: string;
}

export interface ProfilePaths {
  root: string;
  identity: ProfileIdentityPaths;
  state: ProfileStatePaths;
  enginesDir: string;
  cacheDir: string;
  logsDir: string;
  runDir: string;
}

export interface ManagedWorkspacePaths {
  root: string;
  instructionsFile: string;
  readmeFile: string;
  scratchDir: string;
}

export interface AriaLayoutPaths {
  roots: AriaRoots;
  root: RootPaths;
  profile: ProfilePaths;
  workspace: ManagedWorkspacePaths;
}

/** Resolve independent state and managed-workspace roots without filesystem I/O. */
export function resolveAriaRoots(options: ResolveAriaRootsOptions = {}): AriaRoots {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const joinPath = options.pathApi?.join ?? join;
  return {
    stateRoot:
      options.stateRoot ?? env.ARIA_HOME ?? env.LARK_CHANNEL_HOME ?? joinPath(home, '.aria'),
    workspaceRoot:
      options.workspaceRoot ?? env.ARIA_WORKSPACE_HOME ?? joinPath(home, '.aria-workspaces'),
  };
}

/** Compute the target logical layout. This function is deliberately pure. */
export function resolveAriaLayoutPaths(
  roots: AriaRoots,
  profileName: string,
  pathApi: PathJoiner = { join },
): AriaLayoutPaths {
  const joinPath = pathApi.join;
  const profileRoot = joinPath(roots.stateRoot, 'profiles', profileName);
  const identityRoot = joinPath(profileRoot, 'identity');
  const stateRoot = joinPath(profileRoot, 'state');
  const workspaceRoot = joinPath(roots.workspaceRoot, profileName, 'default');
  return {
    roots,
    root: {
      root: roots.stateRoot,
      configFile: joinPath(roots.stateRoot, 'config.json'),
      activeProfileFile: joinPath(roots.stateRoot, 'active-profile'),
      layoutFile: joinPath(roots.stateRoot, 'layout.json'),
      helpersDir: joinPath(roots.stateRoot, 'helpers'),
      profilesDir: joinPath(roots.stateRoot, 'profiles'),
      hostDir: joinPath(roots.stateRoot, 'host'),
      trashDir: joinPath(roots.stateRoot, 'trash'),
    },
    profile: {
      root: profileRoot,
      identity: {
        root: identityRoot,
        secretsFile: joinPath(identityRoot, 'secrets.enc'),
        keystoreSaltFile: joinPath(identityRoot, 'keystore.salt'),
        larkCliSourceDir: joinPath(identityRoot, 'lark-cli-source'),
        larkCliDir: joinPath(identityRoot, 'lark-cli'),
      },
      state: {
        root: stateRoot,
        sessionsFile: joinPath(stateRoot, 'sessions.json'),
        sessionCatalogFile: joinPath(stateRoot, 'session-catalog.json'),
        workspacesFile: joinPath(stateRoot, 'workspaces.json'),
        nativeReadDir: joinPath(stateRoot, 'native-read'),
      },
      enginesDir: joinPath(profileRoot, 'engines'),
      cacheDir: joinPath(profileRoot, 'cache'),
      logsDir: joinPath(profileRoot, 'logs'),
      runDir: joinPath(profileRoot, 'run'),
    },
    workspace: {
      root: workspaceRoot,
      instructionsFile: joinPath(workspaceRoot, 'AGENTS.md'),
      readmeFile: joinPath(workspaceRoot, 'README.md'),
      scratchDir: joinPath(workspaceRoot, 'scratch'),
    },
  };
}
