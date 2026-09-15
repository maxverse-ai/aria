import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertConfinedPath } from './confined-path';
import { FileNativeReadRepository } from './file-native-read-repository';
import { ManagementReadModel, snapshotChange } from '../application/control/management-read-model';
import { NATIVE_READ_RESOURCE_TYPES } from '../application/control/native-read-types';

/** One startup reconciliation. Source journals are read-only, including torn-tail recovery. */
export async function bootstrapManagementRead(model: ManagementReadModel, input: {
  profileId: string; directory?: string; legacy: { snapshotFile: string; journalFile: string };
}): Promise<void> {
  const sources = [{ partition: 'legacy', ...input.legacy }];
  if (input.directory) {
    const root = join(input.directory, 'spaces');
    for (const name of await childDirectories(root)) {
      const control = join(root, name, 'control');
      await assertConfinedPath(input.directory, control);
      sources.push({ partition: name, snapshotFile: join(control, 'native-read.snapshot.json'), journalFile: join(control, 'native-read.journal.jsonl') });
      const audiences = join(control, 'read-audiences');
      for (const audience of await childDirectories(audiences)) {
        const dir = join(audiences, audience); await assertConfinedPath(input.directory, dir);
        sources.push({ partition: audience, snapshotFile: join(dir, 'native-read.snapshot.json'), journalFile: join(dir, 'native-read.journal.jsonl') });
      }
    }
  }
  // Reconcile only the derived index; original history and ownership never change.
  const prior = new Map<string, { type: (typeof NATIVE_READ_RESOURCE_TYPES)[number]; id: string; revision: number }>();
  for (const type of NATIVE_READ_RESOURCE_TYPES) for (const r of await model.repository.list(type)) prior.set(`${type}:${r.id}`, { type, id: r.id, revision: r.revision });
  const seen = new Set<string>();
  for (const source of sources) {
    if (input.directory && source.partition !== 'legacy') {
      await assertConfinedPath(input.directory, source.snapshotFile);
      await assertConfinedPath(input.directory, source.journalFile);
    }
    const repository = new FileNativeReadRepository({ profileId: input.profileId, ...source, readOnly: true });
    for (const type of NATIVE_READ_RESOURCE_TYPES) for (const resource of await repository.list(type)) {
      await model.accept(source.partition, snapshotChange(resource));
      seen.add(`${source.partition}:${type}:${resource.id}`);
    }
  }
  for (const { type, id, revision } of prior.values()) {
    const r = await model.repository.get(type, id);
    const origin = r?.extensions?.['aria.management.origin'] as { partition: string; resourceId: string } | undefined;
    if (origin && r!.revision === revision && !seen.has(`${origin.partition}:${type}:${origin.resourceId}`)) {
      await model.repository.delete({ resourceType: type, resourceId: id, eventId: `reconcile:${id}:${r!.revision}` });
    }
  }
}

async function childDirectories(directory: string): Promise<string[]> {
  try { return (await readdir(directory, { withFileTypes: true })).filter(e => e.isDirectory() && /^[a-f0-9]{64}$/.test(e.name)).map(e => e.name).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
