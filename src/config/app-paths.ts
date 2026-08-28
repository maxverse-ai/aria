import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveAriaRoots, type AriaRoots } from './layout-paths';

export interface ResolveAppPathsOptions {
  rootDir?: string;
  workspaceRoot?: string;
  profile?: string;
}

export interface AppPaths {
  roots: AriaRoots;
  rootDir: string;
  workspaceRoot: string;
  profile: string;
  profileDir: string;
  defaultWorkspaceDir: string;
  configFile: string;
  activeProfileFile: string;
  sessionsFile: string;
  workspacesFile: string;
  secretsFile: string;
  keystoreSaltFile: string;
  secretsGetterScript: string;
  larkCliConfigDir: string;
  larkCliSourceDir: string;
  larkCliSourceConfigFile: string;
  larkCliTargetConfigFile: string;
  mediaDir: string;
  logsDir: string;
  /** Aria-owned normalized read model. Agent-native stores remain untouched. */
  nativeReadDir: string;
  nativeReadSnapshotFile: string;
  nativeReadJournalFile: string;
  nativeReadEndpoint: string;
  runtimeControlFile: string;
  runtimeControlEndpoint: string;
  /** Sidecar file describing the running bridge's local web-config server
   * ({ url, token, port, pid }); written on start, removed on stop. */
  uiFile: string;
  /** Host-level (machine-wide) sidecar for the single supervisor's console. */
  hostUiFile: string;
  /** Host-level supervisor logs dir. */
  hostLogsDir: string;
  /** Machine-wide lock ensuring only one supervisor runs. */
  hostLockFile: string;
  registryDir: string;
  userRegistryFile: string;
  userLockDir: string;
  profileLockFile: string;
  appLockFile(appId: string): string;
}

const DEFAULT_PROFILE = 'claude';

export function resolveAppPaths(opts: ResolveAppPathsOptions = {}): AppPaths {
  const independentRoots = resolveAriaRoots();
  const rootDir = opts.rootDir ?? independentRoots.stateRoot;
  // `rootDir` is the legacy all-in-one option. Preserve its historical sibling
  // workspace mapping at this adapter boundary while new callers pass two roots.
  const compatibilityWorkspaceRoot =
    opts.workspaceRoot ??
    process.env.ARIA_WORKSPACE_HOME ??
    (opts.rootDir || (!process.env.ARIA_HOME && process.env.LARK_CHANNEL_HOME)
      ? `${rootDir}-workspaces`
      : independentRoots.workspaceRoot);
  const roots = resolveAriaRoots({
    stateRoot: rootDir,
    ...(compatibilityWorkspaceRoot ? { workspaceRoot: compatibilityWorkspaceRoot } : {}),
  });
  const profile = normalizeProfileName(opts.profile ?? DEFAULT_PROFILE);
  const profileDir = join(rootDir, 'profiles', profile);
  const registryDir = join(rootDir, 'registry');
  const userLockDir = join(registryDir, 'locks');
  const controlId = createHash('sha256').update(rootDir).update('\0').update(profile).digest('hex').slice(0, 20);

  return {
    roots,
    rootDir,
    workspaceRoot: roots.workspaceRoot,
    profile,
    profileDir,
    defaultWorkspaceDir: join(roots.workspaceRoot, profile, 'default'),
    configFile: join(rootDir, 'config.json'),
    activeProfileFile: join(rootDir, 'active-profile'),
    sessionsFile: join(profileDir, 'sessions.json'),
    workspacesFile: join(profileDir, 'workspaces.json'),
    secretsFile: join(profileDir, 'secrets.enc'),
    keystoreSaltFile: join(profileDir, '.keystore.salt'),
    secretsGetterScript: join(rootDir, 'secrets-getter'),
    larkCliConfigDir: join(profileDir, 'lark-cli'),
    larkCliSourceDir: join(profileDir, 'lark-cli-source'),
    larkCliSourceConfigFile: join(profileDir, 'lark-cli-source', 'config.json'),
    larkCliTargetConfigFile: join(profileDir, 'lark-cli', 'lark-channel', 'config.json'),
    mediaDir: join(profileDir, 'media'),
    logsDir: join(profileDir, 'logs'),
    nativeReadDir: join(profileDir, 'native-read'),
    nativeReadSnapshotFile: join(profileDir, 'native-read', 'snapshot.v1.json'),
    nativeReadJournalFile: join(profileDir, 'native-read', 'changes.v1.jsonl'),
    nativeReadEndpoint:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\aria-native-read-${controlId}`
        : join(profileDir, 'native-read', 'read.sock'),
    runtimeControlFile: join(profileDir, 'runtime-control.json'),
    runtimeControlEndpoint:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\aria-runtime-${controlId}`
        : join(profileDir, 'runtime-control.sock'),
    uiFile: join(profileDir, 'ui.json'),
    hostUiFile: join(rootDir, 'ui.json'),
    hostLogsDir: join(rootDir, 'logs'),
    hostLockFile: join(userLockDir, 'supervisor.lock'),
    registryDir,
    userRegistryFile: join(registryDir, 'processes.json'),
    userLockDir,
    profileLockFile: join(userLockDir, 'profile', `${profile}.lock`),
    appLockFile: (appId: string) => join(userLockDir, 'app', `${lockSafeName(appId)}.lock`),
  };
}

function normalizeProfileName(profile: string): string {
  const trimmed = profile.trim();
  if (!trimmed) throw new Error('profile name is required');
  // Allow Unicode letters/digits (so a non-ASCII bot name can be used directly as
  // the profile name) but reject anything unsafe as a single path segment:
  // whitespace, path separators, control chars, and Windows-reserved chars.
  // Service labels sanitize non-ASCII names separately (see serviceProfileId).
  if (/[\u0000-\u001f\s/\\:*?"<>|]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error(`invalid profile name: ${profile}`);
  }
  return trimmed;
}

function lockSafeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
