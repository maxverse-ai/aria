import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionSpaceSelection } from '../config/execution-spaces';
import { normalizeExecutionSpaceSelection } from '../config/execution-spaces';
import { writeFileAtomic } from '../platform/atomic-write';
import { assertConfinedPath } from './paths';
import { readPrivateJson } from './deployment';

export interface RetainedSpacePreparation {
  schema: 'aria.space.retained.v1'; profileId: string; selection: ExecutionSpaceSelection;
  rolledBackAt: string; legacyDigest: string;
}
const directory = (profileDirectory: string) => join(profileDirectory, 'space-control', 'retained');

/** The offline management owner records a previously active selection. Native
 * state stays in its existing home: no reverse copy or workspace-wide hash that
 * would reject ordinary user files, symlinks, or a large installed dependency. */
export async function retainPreparation(profileDirectory: string, value: RetainedSpacePreparation): Promise<void> {
  const path = join(directory(profileDirectory), value.selection.preparationId + '.json');
  await assertConfinedPath(profileDirectory, path);
  await mkdir(directory(profileDirectory), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, JSON.stringify(value) + '\n', { mode: 0o600 });
}
export async function retainedPreparations(profileDirectory: string, profileId: string): Promise<RetainedSpacePreparation[]> {
  await assertConfinedPath(profileDirectory, directory(profileDirectory));
  let names;
  try { names = await readdir(directory(profileDirectory)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (names.length > 1000) throw new Error('retained preparation inventory exceeds limit');
  const values: RetainedSpacePreparation[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) throw new Error('invalid retained preparation file');
    const value = await readPrivateJson(join(directory(profileDirectory), name), directory(profileDirectory)) as RetainedSpacePreparation;
    normalizeExecutionSpaceSelection(value.selection);
    if (value.schema !== 'aria.space.retained.v1' || value.profileId !== profileId
      || value.selection.preparationId + '.json' !== name || !Number.isFinite(Date.parse(value.rolledBackAt))
      || !/^[a-f0-9]{64}$/.test(value.legacyDigest)) throw new Error('invalid retained preparation');
    values.push(value);
  }
  return values.sort((a, b) => b.rolledBackAt.localeCompare(a.rolledBackAt));
}
