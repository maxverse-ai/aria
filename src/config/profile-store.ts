import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';
import { getEnginePlugin } from '../agent/plugin/registry';
import { resolveAppPaths } from './app-paths';
import {
  normalizeProfileConfig,
  type AgentKind,
  type ProfileConfig,
  type RootConfig,
} from './profile-schema';
import type { AppConfig } from './schema';

export async function loadRootConfig(path: string): Promise<RootConfig | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isRootConfig(parsed) ? normalizeRootConfig(parsed) : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export function normalizeRootConfig(root: RootConfig): RootConfig {
  const profiles: RootConfig['profiles'] = {};
  for (const [name, profile] of Object.entries(root.profiles)) {
    const normalized = normalizeProfileConfig(profile);
    if (normalized.schemaVersion !== root.schemaVersion) {
      throw new Error(
        `profile ${name} schemaVersion ${normalized.schemaVersion} does not match root schemaVersion ${root.schemaVersion}`,
      );
    }
    profiles[name] = normalized;
  }
  if (!root.activeProfile || !profiles[root.activeProfile]) {
    throw new Error(`profile not found: ${root.activeProfile || '<empty activeProfile>'}`);
  }
  return {
    schemaVersion: root.schemaVersion,
    activeProfile: root.activeProfile,
    preferences: {},
    ...(root.secrets ? { secrets: root.secrets } : {}),
    profiles,
  };
}

export async function saveRootConfig(root: RootConfig, path: string): Promise<void> {
  await writeFileAtomic(path, formatRootConfig(root), { mode: 0o600 });
}

export function formatRootConfig(root: RootConfig): string {
  return `${JSON.stringify(serializeRootConfig(root), null, 2)}\n`;
}

type StoredProfileConfig = Pick<
  ProfileConfig,
  | 'schemaVersion'
  | 'agentKind'
  | 'mode'
  | 'executionSpaces'
  | 'accounts'
  | 'secrets'
  | 'preferences'
  | 'access'
  | 'workspaces'
  | 'permissions'
  | 'codex'
  | 'grok'
  | 'opencode'
  | 'dsh'
  | 'kimi'
  | 'pi'
  | 'plugins'
  | 'channels'
  | 'attachments'
  | 'comments'
  | 'meeting'
  | 'larkCli'
>;

type StoredRootConfig = Omit<RootConfig, 'preferences' | 'profiles'> & {
  preferences: Record<string, never>;
  profiles: Record<string, StoredProfileConfig>;
};

function serializeRootConfig(root: RootConfig): StoredRootConfig {
  const profiles: StoredRootConfig['profiles'] = {};
  for (const [name, profile] of Object.entries(root.profiles)) {
    profiles[name] = serializeProfileConfig(profile);
  }
  return {
    schemaVersion: root.schemaVersion,
    activeProfile: root.activeProfile,
    preferences: {},
    ...(root.secrets ? { secrets: root.secrets } : {}),
    profiles,
  };
}

function serializeProfileConfig(profile: ProfileConfig): StoredProfileConfig {
  return {
    schemaVersion: profile.schemaVersion,
    agentKind: profile.agentKind,
    mode: profile.mode,
    ...(profile.executionSpaces ? { executionSpaces: profile.executionSpaces } : {}),
    accounts: profile.accounts,
    ...(profile.secrets ? { secrets: profile.secrets } : {}),
    preferences: profile.preferences,
    access: profile.access,
    workspaces: profile.workspaces,
    permissions: profile.permissions,
    ...(profile.codex ? { codex: profile.codex } : {}),
    ...(profile.grok ? { grok: profile.grok } : {}),
    ...(profile.opencode ? { opencode: profile.opencode } : {}),
    ...(profile.dsh ? { dsh: profile.dsh } : {}),
    ...(profile.kimi ? { kimi: profile.kimi } : {}),
    ...(profile.pi ? { pi: profile.pi } : {}),
    ...(profile.plugins && profile.plugins.length > 0 ? { plugins: profile.plugins } : {}),
    ...(profile.channels ? { channels: profile.channels } : {}),
    attachments: profile.attachments,
    comments: {},
    meeting: profile.meeting,
    larkCli: profile.larkCli,
  };
}

export async function withConfigFileLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
  const lockTarget = `${configPath}.lock`;
  await mkdir(dirname(lockTarget), { recursive: true });
  await writeFile(lockTarget, '', { flag: 'a', mode: 0o600 });
  await chmod(lockTarget, 0o600).catch(() => {});
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: {
      retries: 10,
      minTimeout: 10,
      maxTimeout: 100,
    },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function readActiveProfile(rootDir?: string): Promise<string | undefined> {
  const resolvedRootDir = rootDir ?? process.env.LARK_CHANNEL_HOME ?? resolveAppPaths().rootDir;
  const root = await loadRootConfig(resolveAppPaths({ rootDir: resolvedRootDir }).configFile);
  if (root) return root.activeProfile || undefined;
  return readActiveProfileProjection(resolvedRootDir);
}

/** Raw compatibility projection. Normal profile selection must use config.json. */
export async function readActiveProfileProjection(rootDir?: string): Promise<string | undefined> {
  const activeProfileFile = join(
    rootDir ?? process.env.LARK_CHANNEL_HOME ?? resolveAppPaths().rootDir,
    'active-profile',
  );
  try {
    const text = await readFile(activeProfileFile, 'utf8');
    const profile = text.trim();
    return profile || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function writeActiveProfile(rootDir: string, profile: string): Promise<void> {
  const activeProfileFile = join(rootDir, 'active-profile');
  await writeFileAtomic(activeProfileFile, `${profile}\n`, { mode: 0o600 });
}

export function runtimeProfileConfig(root: RootConfig, profile: string): AppConfig & ProfileConfig {
  const cfg = root.profiles[profile];
  if (!cfg) {
    throw new Error(`profile not found: ${profile}`);
  }
  return {
    ...cfg,
    ...(cfg.secrets ?? root.secrets ? { secrets: cfg.secrets ?? root.secrets } : {}),
  };
}

export function createRootConfig(profile: string, cfg: ProfileConfig, secrets = cfg.secrets): RootConfig {
  return {
    schemaVersion: cfg.schemaVersion,
    activeProfile: profile,
    preferences: {},
    ...(secrets ? { secrets } : {}),
    profiles: {
      [profile]: {
        ...cfg,
        secrets: undefined,
      },
    },
  };
}

export function isRootConfig(value: unknown): value is RootConfig {
  if (!value || typeof value !== 'object') return false;
  const root = value as Partial<RootConfig>;
  return (root.schemaVersion === 2 || root.schemaVersion === 3)
    && Boolean(root.profiles && typeof root.profiles === 'object');
}

export function agentKindFromString(value: string | undefined): AgentKind | undefined {
  if (value === undefined) return undefined;
  if (getEnginePlugin(value)) return value;
  throw new Error(`unsupported agent: ${value}`);
}
