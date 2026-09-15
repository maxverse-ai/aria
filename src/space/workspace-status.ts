import { join } from 'node:path';
import { FileConfigRepository } from '../application/control/config-repository';
import { resolveAppPaths } from '../config/app-paths';
import { SpaceAuthorization } from './authorization';
import { SpaceBindingStore } from './bindings';
import { readSelectedSpaceState } from './selected-profile';
import { readSpaceWorkspaces } from './workspace-definition';
import { SpaceWorkspaces } from './workspace';
import { spaceId } from './identity';
import { openPreparedSpaceHost } from './host';
import { deployedToolRevisions } from './deployment';

/** Host/operator view. No runtime lock, native subprocess, mkdir, install or
 * credential access. A deployment may expose it only to its existing operators. */
export async function inspectSelectedSpaceWorkspaces(input: { rootDir: string; profileId: string }) {
  const appPaths = resolveAppPaths({ rootDir: input.rootDir, profile: input.profileId });
  const profileConfig = (await new FileConfigRepository(input.rootDir).readRoot())?.profiles[appPaths.profile];
  if (!profileConfig) throw new Error('profile not found');
  const selected = await readSelectedSpaceState({ profileId: input.profileId, profileConfig, appPaths });
  if (!selected) return { selected: false, spaces: [] };
  const definition = await readSpaceWorkspaces(join(appPaths.profileDir, 'space-control', 'workspaces.v1.json'), input.profileId);
  const bindings = new SpaceBindingStore(join(selected.staging.state, 'space-control', 'bindings.v1.json'));
  await bindings.load();
  const owner = new SpaceWorkspaces({ profileId: input.profileId, directory: selected.staging.state,
    authorization: new SpaceAuthorization(input.profileId, bindings), engineId: selected.receipt.deployment.engineId,
    driver: selected.receipt.deployment.driver, readonlyResources: selected.receipt.deployment.readonlyResources, definition, availableTools: deployedToolRevisions(selected.receipt.deployment.tools, definition.extensions) });
  try {
    // Assignments also cover future spaces; reading their plans creates nothing.
    const keys = new Map(definition.assignments.map(a => [spaceId(a.space), a.space]));
    for (const key of bindings.spaceKeys()) keys.set(spaceId(key), key);
    const spaces = await Promise.all([...keys].map(async ([id, key]) => ({ spaceId: id, ...await owner.plan(key) })));
    return { selected: true, reload: 'drain-and-restart-profile', spaces };
  } finally { await owner.close(); }
}

/** Explicit operator mutation. Fails while the profile is running, and never
 * changes definitions, starts engines or sends platform messages. */
export async function prepareSelectedSpaceWorkspaces(input: { rootDir: string; profileId: string }) {
  const host = await openPreparedSpaceHost(input);
  try { return { spaces: await host.spaces.workspaces.prepareExisting() }; }
  finally { await host.close(); }
}
