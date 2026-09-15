import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { AppPaths } from '../config/app-paths';
import type { SessionCatalogEntry } from '../session/catalog';
import { digest } from './deployment';
import { assertConfinedPath } from './paths';

export interface LegacySpaceInventory {
  schema: 'aria.space.legacy-inventory.v1';
  digest: string;
  files: readonly { name: string; bytes: number; sha256: string | null }[];
  sessions: readonly SessionCatalogEntry[];
  pendingWork: number;
  idleTimeouts: Readonly<Record<string, number>>;
}

/** Inspect only Aria's legacy ownership indexes. Contents never enter status or
 * public plans. Native rollouts are verified by their engine-specific importer. */
export async function inspectLegacySpaceState(paths: AppPaths): Promise<LegacySpaceInventory> {
  const files = [];
  let sessions: SessionCatalogEntry[] = [];
  let pendingWork = 0;
  const idleTimeouts: Record<string, number> = {};
  for (const [name, path] of [
    ['sessions', paths.sessionsFile], ['catalog', paths.sessionsFile + '.catalog.json'],
    ['workspaces', paths.workspacesFile], ['native-read', paths.nativeReadSnapshotFile],
    ['native-read-journal', paths.nativeReadJournalFile], ['triggers', paths.triggerStateFile],
  ]) {
    await assertConfinedPath(paths.rootDir, path!);
    let data = await readLegacyFile(path!);
    if (name === 'triggers') {
      const raw = data ? JSON.parse(data.toString('utf8')) : { definitions: {}, occurrences: {} };
      if (!raw || !raw.definitions || !raw.occurrences || Array.isArray(raw.definitions) || Array.isArray(raw.occurrences)) throw new Error('invalid legacy trigger state');
      const definitions = Object.values(raw.definitions).filter((value: any) => value.profileId === paths.profile) as Array<{ id: string; state: string }>;
      const occurrences = Object.values(raw.occurrences).filter((value: any) => value.profileId === paths.profile) as Array<{ id: string; state: string }>;
      pendingWork = definitions.filter(value => value.state === 'active').length
        + occurrences.filter(value => !['succeeded', 'skipped', 'dead'].includes(value.state)).length;
      data = Buffer.from(JSON.stringify({ definitions: definitions.sort((a, b) => a.id.localeCompare(b.id)),
        occurrences: occurrences.sort((a, b) => a.id.localeCompare(b.id)) }));
    }
    files.push({ name: name!, bytes: data?.length ?? 0, sha256: data ? digest(data) : null });
    if (name === 'sessions' && data) {
      const parsed = JSON.parse(data.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('legacy session preferences are invalid');
      for (const [scope, value] of Object.entries(parsed)) {
        const minutes = (value as { idleTimeoutMinutes?: unknown } | null)?.idleTimeoutMinutes;
        if (typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 0 && minutes <= 120) idleTimeouts[scope] = minutes;
      }
    }
    if (name === 'catalog' && data) {
      const parsed = JSON.parse(data.toString('utf8')) as unknown;
      if (!Array.isArray(parsed) || parsed.some((entry: SessionCatalogEntry) => !entry
        || typeof entry.key !== 'string' || typeof entry.scopeId !== 'string' || !entry.scopeId
        || typeof entry.agentId !== 'string' || !entry.agentId || typeof entry.cwdRealpath !== 'string'
        || typeof entry.policyFingerprint !== 'string' || !['active', 'archived'].includes(entry.status)
        || !Number.isFinite(entry.updatedAt))) throw new Error('legacy catalog is invalid; migration cannot skip damaged entries');
      sessions = parsed;
      if (new Set(sessions.map((entry) => entry.key)).size !== sessions.length) throw new Error('duplicate legacy catalog keys');
    }
  }
  return { schema: 'aria.space.legacy-inventory.v1', digest: digest(JSON.stringify(files)), files, sessions, pendingWork, idleTimeouts };
}

async function readLegacyFile(path: string): Promise<Buffer | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 128 * 1024 * 1024) throw new Error('legacy index is not a bounded regular file');
    const data = await file.readFile();
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('legacy state changed during inventory');
    }
    return data;
  } finally { await file.close(); }
}
