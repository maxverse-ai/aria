import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from './atomic-write';
import { decodeNativeReadCursor, encodeNativeReadCursor } from '../application/control/native-read-cursor';
import {
  NativeReadRepositoryError,
  type NativeReadChangePage,
  type NativeReadDelete,
  type NativeReadRepository,
  type NativeReadResourceDraft,
  type NativeReadUpsert,
} from '../application/control/native-read-repository';
import type {
  NativeReadChange,
  NativeReadCursor,
  NativeReadResource,
  NativeReadResourceType,
} from '../application/control/native-read-types';

const SNAPSHOT_SCHEMA = 'aria.read.snapshot.v1' as const;
const JOURNAL_SCHEMA = 'aria.read.journal-entry.v1' as const;
const DEFAULT_CHANGE_LIMIT = 100;
const MAX_CHANGE_LIMIT = 1_000;

interface NativeReadSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  profileId: string;
  sequence: number;
  resources: NativeReadResource[];
}

interface NativeReadJournalEntry {
  schema: typeof JOURNAL_SCHEMA;
  profileId: string;
  sequence: number;
  change: NativeReadChange;
}

export interface FileNativeReadRepositoryOptions {
  profileId: string;
  snapshotFile: string;
  journalFile: string;
  now?: () => string;
  /** Offline observation must never repair or rewrite another owner's stores. */
  readOnly?: boolean;
  /** Derived indexes may checkpoint less often; every journal append stays durable. */
  snapshotEvery?: number;
}

/**
 * Durable, single-writer materialized read model for one Aria profile.
 *
 * The journal is the durability boundary. The atomic snapshot is a rebuildable
 * acceleration structure and never replaces or mutates an agent-native store.
 */
export class FileNativeReadRepository implements NativeReadRepository {
  readonly profileId: string;
  private readonly snapshotFile: string;
  private readonly journalFile: string;
  private readonly now: () => string;
  private readonly readOnly: boolean;
  private readonly snapshotEvery: number;
  private initialized = false;
  private sequence = 0;
  private readonly resources = new Map<string, NativeReadResource>();
  private readonly revisions = new Map<string, number>();
  private readonly changesBySequence: NativeReadChange[] = [];
  private readonly changesByEventId = new Map<string, NativeReadChange>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: FileNativeReadRepositoryOptions) {
    if (!options.profileId.trim()) {
      throw new NativeReadRepositoryError('INVALID_INPUT', 'profileId is required');
    }
    this.profileId = options.profileId;
    this.snapshotFile = options.snapshotFile;
    this.journalFile = options.journalFile;
    this.now = options.now ?? (() => new Date().toISOString());
    this.readOnly = options.readOnly ?? false;
    this.snapshotEvery = options.snapshotEvery ?? 1;
    if (!Number.isSafeInteger(this.snapshotEvery) || this.snapshotEvery < 1) throw new Error('invalid snapshot interval');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.enqueue(async () => {
      if (this.initialized) return;
      await this.loadSnapshot();
      await this.replayJournal();
      this.initialized = true;
    });
  }

  async currentCursor(): Promise<NativeReadCursor> {
    await this.initialize();
    return encodeNativeReadCursor(this.profileId, this.sequence);
  }

  async get<T extends NativeReadResource>(resourceType: T['resourceType'], id: string): Promise<T | undefined> {
    await this.initialize();
    const resource = this.resources.get(resourceKey(resourceType, id));
    return resource === undefined ? undefined : (structuredClone(resource) as T);
  }

  async list<T extends NativeReadResource>(resourceType: T['resourceType']): Promise<readonly T[]> {
    await this.initialize();
    return [...this.resources.values()]
      .filter((resource): resource is T => resource.resourceType === resourceType)
      .sort(compareResources)
      .map((resource) => structuredClone(resource));
  }

  async upsert<T extends NativeReadResource>(input: NativeReadUpsert<T>): Promise<NativeReadChange> {
    await this.initialize();
    return this.mutate(input.eventId, async () => {
      validateEventId(input.eventId);
      validateResource(input.resource, this.profileId);
      const key = resourceKey(input.resource.resourceType, input.resource.id);
      const revision = (this.revisions.get(key) ?? 0) + 1;
      const resource = {
        ...structuredClone(input.resource),
        revision,
      } as unknown as NativeReadResource;
      const change: NativeReadChange = {
        cursor: encodeNativeReadCursor(this.profileId, this.sequence + 1),
        eventId: input.eventId,
        changedAt: input.changedAt ?? this.now(),
        operation: 'upsert',
        resourceType: resource.resourceType,
        resourceId: resource.id,
        revision,
        resource,
      };
      await this.persistChange(change);
      return change;
    });
  }

  async delete(input: NativeReadDelete): Promise<NativeReadChange> {
    await this.initialize();
    return this.mutate(input.eventId, async () => {
      validateEventId(input.eventId);
      if (!input.resourceId) {
        throw new NativeReadRepositoryError('INVALID_INPUT', 'resourceId is required');
      }
      const revision = (this.revisions.get(resourceKey(input.resourceType, input.resourceId)) ?? 0) + 1;
      const change: NativeReadChange = {
        cursor: encodeNativeReadCursor(this.profileId, this.sequence + 1),
        eventId: input.eventId,
        changedAt: input.changedAt ?? this.now(),
        operation: 'delete',
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        revision,
      };
      await this.persistChange(change);
      return change;
    });
  }

  async changes(after: NativeReadCursor | null, limit = DEFAULT_CHANGE_LIMIT): Promise<NativeReadChangePage> {
    await this.initialize();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHANGE_LIMIT) {
      throw new NativeReadRepositoryError('INVALID_INPUT', `limit must be between 1 and ${MAX_CHANGE_LIMIT}`);
    }
    const afterSequence = after === null ? 0 : decodeNativeReadCursor(after, this.profileId);
    if (afterSequence > this.sequence) {
      throw new NativeReadRepositoryError('CURSOR_INVALID', 'cursor is ahead of the repository');
    }
    const selected = this.changesBySequence.slice(afterSequence, afterSequence + limit);
    const nextSequence = selected.length === 0 ? afterSequence : afterSequence + selected.length;
    return {
      after,
      nextCursor: encodeNativeReadCursor(this.profileId, nextSequence),
      hasMore: nextSequence < this.sequence,
      changes: structuredClone(selected),
    };
  }

  private async mutate(eventId: string, operation: () => Promise<NativeReadChange>): Promise<NativeReadChange> {
    if (this.readOnly) throw new NativeReadRepositoryError('INVALID_INPUT', 'read-only repository');
    let result: NativeReadChange | undefined;
    await this.enqueue(async () => {
      const existing = this.changesByEventId.get(eventId);
      result = structuredClone(existing ?? (await operation()));
    });
    return result as NativeReadChange;
  }

  private async persistChange(change: NativeReadChange): Promise<void> {
    const sequence = this.sequence + 1;
    const entry: NativeReadJournalEntry = {
      schema: JOURNAL_SCHEMA,
      profileId: this.profileId,
      sequence,
      change,
    };
    await appendDurably(this.journalFile, `${JSON.stringify(entry)}\n`);
    this.applyEntry(entry);
    if (sequence % this.snapshotEvery === 0) await this.writeSnapshot();
  }

  private applyEntry(entry: NativeReadJournalEntry): void {
    if (entry.sequence !== this.sequence + 1) {
      throw new NativeReadRepositoryError('STORAGE_CORRUPT', `non-contiguous journal sequence ${entry.sequence}`);
    }
    if (entry.change.operation === 'upsert' && entry.change.resource) {
      this.resources.set(resourceKey(entry.change.resourceType, entry.change.resourceId), entry.change.resource);
    } else {
      this.resources.delete(resourceKey(entry.change.resourceType, entry.change.resourceId));
    }
    this.sequence = entry.sequence;
    this.revisions.set(
      resourceKey(entry.change.resourceType, entry.change.resourceId),
      entry.change.revision,
    );
    this.changesBySequence.push(entry.change);
    this.changesByEventId.set(entry.change.eventId, entry.change);
  }

  private async loadSnapshot(): Promise<void> {
    const text = await readOptionalFile(this.snapshotFile);
    if (text === undefined) return;
    try {
      const snapshot = JSON.parse(text) as NativeReadSnapshot;
      if (snapshot.schema !== SNAPSHOT_SCHEMA || snapshot.profileId !== this.profileId || !Number.isSafeInteger(snapshot.sequence)) {
        throw new Error('invalid snapshot metadata');
      }
      this.sequence = snapshot.sequence;
      for (const resource of snapshot.resources) {
        validateResource(resource, this.profileId);
        this.resources.set(resourceKey(resource.resourceType, resource.id), resource);
      }
    } catch {
      // The journal is authoritative. A torn or stale snapshot is rebuilt below.
      this.sequence = 0;
      this.resources.clear();
      this.revisions.clear();
    }
  }

  private async replayJournal(): Promise<void> {
    const text = await readOptionalFile(this.journalFile);
    if (text === undefined || text.length === 0) {
      if (this.sequence > 0 || this.resources.size > 0) {
        this.sequence = 0;
        this.resources.clear();
        this.revisions.clear();
        await this.writeSnapshot();
      }
      return;
    }
    const lines = text.split('\n');
    const entries: NativeReadJournalEntry[] = [];
    let repairedTrailingWrite = false;
    let lastNonEmptyIndex = lines.length - 1;
    while (lastNonEmptyIndex >= 0 && lines[lastNonEmptyIndex]?.length === 0) lastNonEmptyIndex -= 1;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      let entry: NativeReadJournalEntry;
      try {
        entry = JSON.parse(line) as NativeReadJournalEntry;
      } catch (error) {
        const isTrailingLine = index === lastNonEmptyIndex;
        if (isTrailingLine) {
          repairedTrailingWrite = true;
          break;
        }
        throw new NativeReadRepositoryError('STORAGE_CORRUPT', `invalid journal entry at line ${index + 1}`, error);
      }
      validateEntry(entry, this.profileId);
      entries.push(entry);
    }

    const snapshotSequence = this.sequence;
    this.changesBySequence.length = 0;
    this.changesByEventId.clear();
    this.revisions.clear();
    let expected = 1;
    for (const entry of entries) {
      if (entry.sequence !== expected) {
        throw new NativeReadRepositoryError('STORAGE_CORRUPT', `non-contiguous journal sequence ${entry.sequence}`);
      }
      const key = resourceKey(entry.change.resourceType, entry.change.resourceId);
      const expectedRevision = (this.revisions.get(key) ?? 0) + 1;
      if (entry.change.revision !== expectedRevision) {
        throw new NativeReadRepositoryError(
          'STORAGE_CORRUPT',
          `non-contiguous revision ${entry.change.revision} for ${entry.change.resourceType}/${entry.change.resourceId}`,
        );
      }
      this.changesBySequence.push(entry.change);
      if (this.changesByEventId.has(entry.change.eventId)) {
        throw new NativeReadRepositoryError('STORAGE_CORRUPT', `duplicate eventId ${entry.change.eventId}`);
      }
      this.changesByEventId.set(entry.change.eventId, entry.change);
      this.revisions.set(
        resourceKey(entry.change.resourceType, entry.change.resourceId),
        entry.change.revision,
      );
      if (entry.sequence > snapshotSequence) {
        if (entry.change.operation === 'upsert' && entry.change.resource) {
          this.resources.set(resourceKey(entry.change.resourceType, entry.change.resourceId), entry.change.resource);
        } else {
          this.resources.delete(resourceKey(entry.change.resourceType, entry.change.resourceId));
        }
      }
      expected += 1;
    }
    this.sequence = entries.length;
    if (snapshotSequence > entries.length) {
      // A snapshot can never be ahead of its authoritative journal.
      this.sequence = 0;
      this.resources.clear();
      this.revisions.clear();
      this.changesBySequence.length = 0;
      this.changesByEventId.clear();
      for (const entry of entries) this.applyEntry(entry);
    }
    if (repairedTrailingWrite && !this.readOnly) {
      await writeFileAtomic(
        this.journalFile,
        entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''),
        { mode: 0o600 },
      );
    }
    await this.writeSnapshot();
  }

  private async writeSnapshot(): Promise<void> {
    if (this.readOnly) return;
    const snapshot: NativeReadSnapshot = {
      schema: SNAPSHOT_SCHEMA,
      profileId: this.profileId,
      sequence: this.sequence,
      resources: [...this.resources.values()].sort(compareResources),
    };
    await writeFileAtomic(this.snapshotFile, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function resourceKey(type: NativeReadResourceType, id: string): string {
  return `${type}\0${id}`;
}

function compareResources(left: NativeReadResource, right: NativeReadResource): number {
  return left.resourceType.localeCompare(right.resourceType) || left.id.localeCompare(right.id);
}

function validateEventId(eventId: string): void {
  if (!eventId.trim()) throw new NativeReadRepositoryError('INVALID_INPUT', 'eventId is required');
}

function validateResource(resource: NativeReadResourceDraft | NativeReadResource, profileId: string): void {
  if (!resource.id || resource.profileId !== profileId) {
    throw new NativeReadRepositoryError('PROFILE_MISMATCH', 'resource does not belong to this profile');
  }
}

function validateEntry(entry: NativeReadJournalEntry, profileId: string): void {
  if (
    !entry ||
    entry.schema !== JOURNAL_SCHEMA ||
    entry.profileId !== profileId ||
    !Number.isSafeInteger(entry.sequence) ||
    entry.sequence < 1 ||
    !entry.change ||
    typeof entry.change.eventId !== 'string' ||
    entry.change.eventId.length === 0
  ) {
    throw new NativeReadRepositoryError('STORAGE_CORRUPT', 'invalid journal entry');
  }
  let cursorSequence: number;
  try {
    cursorSequence = decodeNativeReadCursor(entry.change.cursor, profileId);
  } catch (error) {
    throw new NativeReadRepositoryError('STORAGE_CORRUPT', 'invalid journal cursor', error);
  }
  if (cursorSequence !== entry.sequence) {
    throw new NativeReadRepositoryError('STORAGE_CORRUPT', 'journal cursor does not match its sequence');
  }
  if (entry.change.operation === 'upsert') {
    if (
      entry.change.resource === undefined ||
      entry.change.resource.resourceType !== entry.change.resourceType ||
      entry.change.resource.id !== entry.change.resourceId ||
      entry.change.resource.revision !== entry.change.revision
    ) {
      throw new NativeReadRepositoryError('STORAGE_CORRUPT', 'journal upsert resource does not match change metadata');
    }
    validateResource(entry.change.resource, profileId);
  } else if (entry.change.resource !== undefined) {
    throw new NativeReadRepositoryError('STORAGE_CORRUPT', 'journal delete must not include a resource');
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function appendDurably(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}
