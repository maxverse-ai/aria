import type { EngineProfileConfig } from '../config/profile-schema';
import { clampAccess, permissionsToLegacySandbox, type AccessMode } from '../config/permissions';
import type { SpacePaths } from './paths';

/** Shared projection for live policy evaluation and migration catalog identity. */
export function spacePolicyProfile(profile: EngineProfileConfig, paths: SpacePaths, ceiling: AccessMode): EngineProfileConfig {
  const access = clampAccess(profile.permissions.defaultAccess, profile.permissions.maxAccess, ceiling);
  return { ...profile, permissions: { ...profile.permissions, defaultAccess: access, maxAccess: access },
    sandbox: permissionsToLegacySandbox({ defaultAccess: access, maxAccess: access }),
    workspaces: { ...profile.workspaces, default: paths.workspace } };
}
