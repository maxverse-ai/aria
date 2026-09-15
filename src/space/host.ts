import { resolveAppPaths } from '../config/app-paths';
import { FileConfigRepository } from '../application/control/config-repository';
import { acquireProfileRuntimeLock } from '../runtime/locks';
import { createSelectedSpaceProfile } from './selected-profile';

/** Composition entry for non-Supervisor deployments and offline rehearsals.
 * Owns the same profile lock as Supervisor and management: one physical writer. */
export async function openPreparedSpaceHost(input: { rootDir: string; profileId: string }) {
  const paths = resolveAppPaths({ rootDir: input.rootDir, profile: input.profileId });
  const repository = new FileConfigRepository(input.rootDir);
  const before = (await repository.readRoot())?.profiles[paths.profile];
  if (!before?.executionSpaces) throw new Error('profile has no selected space preparation');
  const lock = await acquireProfileRuntimeLock(paths, before.agentKind);
  try {
    const profileConfig = (await repository.readRoot())?.profiles[paths.profile];
    if (!profileConfig?.executionSpaces) throw new Error('profile space selection changed');
    const spaces = await createSelectedSpaceProfile({ profileId: paths.profile, profileConfig, appPaths: paths });
    if (!spaces) throw new Error('profile has no prepared execution spaces');
    let closing: Promise<void> | undefined;
    return { spaces, close: () => closing ??= (async () => {
      try { await spaces.services.close(); } finally { await lock.release(); }
    })() };
  } catch (error) { await lock.release(); throw error; }
}
