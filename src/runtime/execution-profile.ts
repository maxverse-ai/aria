import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { normalizeEngineProfileConfig } from '../config/profile-schema';

/** Read the ordinary profile's execution settings without bootstrapping accounts.
 * Channel startup remains responsible for validating its own account and transport. */
export async function resolveExecutionProfile(configPath: string, profile: string) {
  const root = JSON.parse(await readFile(configPath, 'utf8'));
  if (root?.kind === 'aria-worker') return undefined;
  if (![2, 3].includes(root?.schemaVersion) || !root.profiles || !Object.hasOwn(root.profiles, profile)) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile)) throw new Error('invalid execution profile');
  const profileConfig = normalizeEngineProfileConfig(root.profiles[profile]);
  return { profileConfig, cfg: profileConfig, profile, configPath,
    appPaths: resolveAppPaths({ rootDir: dirname(configPath), profile }) };
}
