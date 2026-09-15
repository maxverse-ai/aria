import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { normalizeEngineProfileConfig, type EngineProfileConfig } from '../config/profile-schema';

export interface WorkerConfig {
  kind: 'aria-worker';
  schemaVersion: 1;
  activeProfile: string;
  profiles: Record<string, EngineProfileConfig>;
}

/** Standalone workers contain engine settings and never require channel credentials. */
export async function loadWorkerConfig(configPath: string): Promise<WorkerConfig | undefined> {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  if (raw?.kind !== 'aria-worker') return undefined;
  if (raw.schemaVersion !== 1 || !raw.profiles || typeof raw.profiles !== 'object' || Array.isArray(raw.profiles)) {
    throw new Error('Invalid standalone worker configuration');
  }
  const profiles: Record<string, EngineProfileConfig> = Object.create(null);
  for (const [name, value] of Object.entries(raw.profiles)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid standalone worker profile');
    }
    const profile = value as Record<string, unknown>;
    if ('accounts' in profile || 'channels' in profile || 'secrets' in profile || 'schemaVersion' in profile) {
      throw new Error('Standalone worker profiles cannot declare channel configuration');
    }
    profiles[name] = normalizeEngineProfileConfig({ ...profile, schemaVersion: 2 });
  }
  if (typeof raw.activeProfile !== 'string' || !Object.hasOwn(profiles, raw.activeProfile)) {
    throw new Error('Standalone active profile is unavailable');
  }
  return { kind: 'aria-worker', schemaVersion: 1, activeProfile: raw.activeProfile, profiles };
}

export async function resolveWorkerProfile(configPath: string, profile: string) {
  const root = await loadWorkerConfig(configPath);
  if (!root) return undefined;
  if (!Object.hasOwn(root.profiles, profile)) throw new Error('Standalone worker profile is unavailable');
  const profileConfig = root.profiles[profile]!;
  return {
    profileConfig,
    cfg: profileConfig,
    configPath,
    profile,
    appPaths: resolveAppPaths({ rootDir: dirname(configPath), profile }),
  };
}
