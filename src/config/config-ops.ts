import { dirname } from 'node:path';
import { resolveAppPaths } from './app-paths';
import type { AppConfig } from './schema';
import type { ProfileConfig } from './profile-schema';
import { applyLarkCliIdentityPolicy } from '../lark-cli/identity-policy';
import { log } from '../core/logger';

/**
 * The mutable per-profile runtime state these ops read and keep in sync. The
 * running bridge's `Controls` object structurally satisfies this. This is the
 * mutable profile projection shared by in-process adapters. Public config
 * writers use `ManagementApi`; this module only retains the lark-cli identity
 * side effect that must happen before a settings commit.
 */
export interface MutableProfileState {
  configPath: string;
  profile: string;
  cfg: AppConfig;
  profileConfig: ProfileConfig;
}

/** App paths for a profile, derived from its config path. */
export function profileAppPaths(state: Pick<MutableProfileState, 'configPath' | 'profile'>) {
  return resolveAppPaths({
    rootDir: dirname(state.configPath),
    profile: state.profile,
  });
}

/**
 * Apply the lark-cli identity policy (`strict-mode` + `default-as`) for a
 * profile. Pass the *effective* preset (team mode forces `bot-only` — see
 * {@link effectiveLarkCliIdentity}). Returns false on failure (logged).
 */
export async function applyProfileLarkCliIdentity(
  state: Pick<MutableProfileState, 'configPath' | 'profile'>,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<boolean> {
  const appPaths = profileAppPaths(state);
  const ok = await applyLarkCliIdentityPolicy({
    profile: appPaths.profile,
    rootDir: appPaths.rootDir,
    configPath: state.configPath,
    larkCliConfigDir: appPaths.larkCliConfigDir,
    larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
  }, larkCliIdentity).catch(() => false);
  if (!ok) {
    log.warn('config-ops', 'lark-cli-identity-policy-apply-failed', {
      profile: appPaths.profile,
      identity: larkCliIdentity,
    });
  }
  return ok;
}
