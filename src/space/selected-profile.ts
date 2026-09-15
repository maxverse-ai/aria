import { createExecutionBackend } from '../execution/configuration';
import type { AppPaths } from '../config/app-paths';
import type { ProfileConfig } from '../config/profile-schema';
import { readPreparation, executionFingerprint, preparationStoragePaths } from './preparation-store';
import { resolveSpaceDeployment, probeSpaceDeployment } from './deployment';
import { PreparedSpaceProfile } from './profile';
import { prepareSpacePaths, resolveSpacePaths } from './paths';
import { join } from 'node:path';
import { readSpaceWorkspaces } from './workspace-definition';

/** Stored selection is only a pointer. Startup verifies the immutable receipt
 * and the selected deployment; there is no ambient-home fallback on failure. */
export async function createSelectedSpaceProfile(input: {
  profileId: string; profileConfig: ProfileConfig; appPaths: AppPaths;
}): Promise<PreparedSpaceProfile | undefined> {
  const selected = await readSelectedSpaceState(input);
  if (!selected) return undefined;
  const { receipt, staging } = selected;
  const directory = staging.state;
  const probePaths = resolveSpacePaths(join(staging.directory, 'probe'), { kind: 'default', profileId: input.profileId });
  await prepareSpacePaths(probePaths);
  await probeSpaceDeployment(receipt.deployment, probePaths);
  return PreparedSpaceProfile.create({ profileId: input.profileId, profile: input.profileConfig, directory,
    workspaces: await readSpaceWorkspaces(join(input.appPaths.profileDir, 'space-control', 'workspaces.v1.json'), input.profileId),
    ...(receipt.deployment.execution ? { executionBackend: createExecutionBackend(receipt.deployment.execution) } : {}),
    deployment: resolveSpaceDeployment(receipt.deployment) });
}

/** Shared, read-only selection verification for runtime and operator views. */
export async function readSelectedSpaceState(input: { profileId: string; profileConfig: ProfileConfig; appPaths: AppPaths }) {
  const selection = input.profileConfig.executionSpaces;
  if (!selection) return undefined;
  if (input.profileConfig.mode !== 'team') throw new Error('execution spaces require team mode');
  const receipt = await readPreparation(input.appPaths.profileDir, selection);
  if (receipt.profileId !== input.profileId || receipt.executionFingerprint !== executionFingerprint(input.profileConfig)) {
    throw new Error('execution space preparation no longer matches profile configuration');
  }
  const staging = preparationStoragePaths(input.appPaths.profileDir, receipt);
  return { receipt, staging };
}
