import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ProfileMode } from '../config/profile-schema';
import { normalizeExecutionSpaceSelection, type ExecutionSpaceSelection } from '../config/execution-spaces';
import { writeFileAtomic } from '../platform/atomic-write';
import { digest, normalizeSpaceDeployment, readPrivateJson, type SpaceDeploymentDefinition } from './deployment';
import { assertConfinedPath } from './paths';

export interface SpacePreparationReceipt {
  schema: 'aria.space.preparation.v1' | 'aria.space.preparation.v2';
  /** Upgrade receipts retain the original physical data root and its CLI bindings. */
  storage?: { preparationId: string; backupDigest: string };
  id: string;
  profileId: string;
  createdAt: string;
  baseRevision: string;
  executionFingerprint: string;
  original: { mode: ProfileMode; executionSpaces?: ExecutionSpaceSelection };
  deployment: SpaceDeploymentDefinition;
  migration: { catalogDigest: string; stateDigest: string; sourceChecks: readonly { path: string; sha256: string }[];
    importedSessions: number; sealedSessions: number; verified: boolean };
}

/** Configuration that changes native ownership/admission needs a new preparation.
 * Presentation and model preferences may still reconcile through their owners. */
export { executionSpaceFingerprint as executionFingerprint } from '../config/execution-spaces';

export function preparationPaths(profileDirectory: string, id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('invalid space preparation id');
  const directory = join(profileDirectory, 'space-control', 'preparations', id);
  return { directory, receipt: join(directory, 'receipt.json'), state: join(directory, 'state'), journal: join(directory, 'migration.json') };
}

export async function writePreparation(profileDirectory: string, receipt: SpacePreparationReceipt): Promise<ExecutionSpaceSelection> {
  const paths = preparationPaths(profileDirectory, receipt.id);
  await assertConfinedPath(profileDirectory, paths.receipt);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const content = JSON.stringify(receipt);
  // Receipt is immutable. Replaying exactly the same completed preparation is safe.
  try {
    const existing = await readPrivateJson(paths.receipt, profileDirectory);
    if (JSON.stringify(existing) !== content) throw new Error('space preparation already sealed with different contents');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFileAtomic(paths.receipt, content + '\n', { mode: 0o600 });
  }
  return { schema: 'aria.space.selection.v1', preparationId: receipt.id, receiptDigest: digest(content) };
}

export async function readPreparation(profileDirectory: string, selection: ExecutionSpaceSelection, depth = 0): Promise<SpacePreparationReceipt> {
  if (depth >= 64) throw new Error('preparation ancestry is too deep or cyclic');
  const selected = normalizeExecutionSpaceSelection(selection)!;
  const paths = preparationPaths(profileDirectory, selected.preparationId);
  await assertConfinedPath(profileDirectory, paths.receipt);
  const value = await readPrivateJson(paths.receipt, profileDirectory) as SpacePreparationReceipt;
  if (!value || digest(JSON.stringify(value)) !== selected.receiptDigest
    || !['aria.space.preparation.v1', 'aria.space.preparation.v2'].includes(value.schema) || value.id !== selected.preparationId
    || typeof value.profileId !== 'string' || !value.profileId
    || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.baseRevision !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.executionFingerprint)
    || !value.original || !['personal', 'team'].includes(value.original.mode)
    || !value.migration?.verified || !/^[a-f0-9]{64}$/.test(value.migration.catalogDigest) || !/^[a-f0-9]{64}$/.test(value.migration.stateDigest)
    || !Array.isArray(value.migration.sourceChecks) || value.migration.sourceChecks.length > 10_000
    || value.migration.sourceChecks.some(check => !check || !isAbsolute(check.path ?? '') || !/^[a-f0-9]{64}$/.test(check.sha256))
    || !Number.isSafeInteger(value.migration.importedSessions) || value.migration.importedSessions < 0
    || !Number.isSafeInteger(value.migration.sealedSessions) || value.migration.sealedSessions < 0) {
    throw new Error('invalid or changed execution space preparation');
  }
  if (value.schema === 'aria.space.preparation.v2') {
    if (!value.original.executionSpaces || !value.storage || !/^[a-f0-9]{32}$/.test(value.storage.preparationId)
      || !/^[a-f0-9]{64}$/.test(value.storage.backupDigest)) throw new Error('invalid preparation storage reference');
    const parent = await readPreparation(profileDirectory, value.original.executionSpaces, depth + 1);
    if (parent.profileId !== value.profileId || value.storage.preparationId !== (parent.storage?.preparationId ?? parent.id)) {
      throw new Error('preparation storage belongs to another origin');
    }
  } else if (value.storage !== undefined) throw new Error('legacy preparation cannot redirect storage');
  normalizeSpaceDeployment(value.deployment);
  normalizeExecutionSpaceSelection(value.original.executionSpaces);
  return value;
}

export function preparationStoragePaths(profileDirectory: string, receipt: SpacePreparationReceipt) {
  return { ...preparationPaths(profileDirectory, receipt.id),
    state: preparationPaths(profileDirectory, receipt.storage?.preparationId ?? receipt.id).state };
}
