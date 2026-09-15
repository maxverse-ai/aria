import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { NativeReadRepository } from './native-read-repository';
import { NativeReadRepositoryError } from './native-read-repository';
import { nativeReadOpaqueId } from './native-read-identifiers';
import type { NativeChatResource, NativeIdentityResource, NativeMessageResource, NativeReadChange,
  NativeReadResource, NativeSessionResource } from './native-read-types';

export interface NativeSessionSummary {
  session: NativeSessionResource;
  lastUser?: NativeIdentityResource;
  chat?: NativeChatResource;
  owner?: NativeIdentityResource;
  messageCount: number;
  toolCount: number;
  runCount: number;
  preview?: string;
}

/** Host-owned derived view. It never creates Space authority or writes source stores. */
export class ManagementReadModel {
  private generation = -1;
  private summaryRevision = 0;
  private summaries: NativeSessionSummary[] = [];
  private readonly snapshots = new Map<string, { rows: NativeSessionSummary[]; expires: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly repository: NativeReadRepository, private readonly now = Date.now) {}

  async accept(partition: string, change: NativeReadChange): Promise<void> {
    return this.serialize(() => this.acceptChange(partition, change));
  }
  async flush(): Promise<void> { return this.serialize(async () => {}); }
  private async acceptChange(partition: string, change: NativeReadChange): Promise<void> {
    const id = (value: string) => nativeReadOpaqueId('management', this.repository.profileId, partition, value);
    const eventId = id(change.eventId);
    if (!change.resource) {
      await this.repository.delete({ eventId, changedAt: change.changedAt,
        resourceType: change.resourceType, resourceId: id(change.resourceId) });
      this.invalidate(change.resourceType);
      return;
    }
    const resource = structuredClone(change.resource);
    resource.id = id(resource.id);
    resource.extensions = { ...resource.extensions, 'aria.management.origin': {
      kind: partition === 'legacy' ? 'legacy' : 'space', partition,
      resourceId: change.resourceId, sourceRevision: change.revision,
    } };
    // IDs are confined to their physical source, including all references.
    const references = resource as unknown as Record<string, unknown>;
    for (const key of ['conversationId', 'sessionId', 'runId', 'chatId', 'ownerIdentityId', 'actorIdentityId', 'identityId']) {
      if (typeof references[key] === 'string') references[key] = id(references[key] as string);
    }
    for (const key of ['participantIdentityIds', 'attachmentIds']) {
      if (Array.isArray(references[key])) references[key] = (references[key] as string[]).map(id);
    }
    if (resource.resourceType === 'audit-event') {
      if (resource.actor.identityId) resource.actor.identityId = id(resource.actor.identityId);
      if (resource.target?.resourceId) resource.target.resourceId = id(resource.target.resourceId);
    }
    const previous = await this.repository.get(resource.resourceType, resource.id);
    const previousOrigin = previous?.extensions?.['aria.management.origin'] as { sourceRevision?: number } | undefined;
    const { revision: ignored, ...draft } = resource;
    if (previous) {
      const { revision: ignoredPrevious, ...previousDraft } = previous;
      if (isDeepStrictEqual(previousDraft, draft)) return;
      if ((previousOrigin?.sourceRevision ?? 0) >= change.revision) return;
    }
    await this.repository.upsert({ eventId: change.eventId.startsWith('bootstrap:') ? `${eventId}:${previous?.revision ?? 0}` : eventId,
      changedAt: change.changedAt, resource: draft });
    this.invalidate(change.resourceType);
  }

  /** One bounded immutable snapshot for a complete cursor traversal. No time-based re-sort. */
  async page(limit: number, cursor?: string) {
    return this.serialize(() => this.readPage(limit, cursor));
  }
  private async readPage(limit: number, cursor?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new NativeReadRepositoryError('INVALID_INPUT', 'invalid page size');
    for (const [key, value] of this.snapshots) if (value.expires <= this.now()) this.snapshots.delete(key);
    let key: string; let offset = 0; let rows: NativeSessionSummary[];
    if (cursor) {
      const match = /^([a-f0-9-]{36})\.(\d+)$/.exec(cursor);
      const snapshot = match ? this.snapshots.get(match[1]!) : undefined;
      if (!match || !snapshot) throw new NativeReadRepositoryError('CURSOR_INVALID', 'management snapshot expired; restart listing');
      key = match[1]!; offset = Number(match[2]); rows = snapshot.rows;
      if (!Number.isSafeInteger(offset) || offset > rows.length) throw new NativeReadRepositoryError('CURSOR_INVALID', 'invalid offset');
    } else {
      rows = await this.current(); key = randomUUID();
      if (this.snapshots.size >= 8) this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(key, { rows, expires: this.now() + 60_000 });
    }
    const end = offset + limit;
    return { schema: 'aria.read.session-summaries.v1' as const, apiVersion: 1,
      total: rows.length, items: rows.slice(offset, end),
      ...(end < rows.length ? { nextCursor: `${key}.${end}` } : {}) };
  }

  private async current(): Promise<NativeSessionSummary[]> {
    const generation = this.summaryRevision;
    if (generation === this.generation) return this.summaries;
    const sessions = await this.repository.list<NativeSessionResource>('session');
    const identities = new Map((await this.repository.list<NativeIdentityResource>('identity')).map(x => [x.id, x]));
    const chats = new Map((await this.repository.list<NativeChatResource>('chat')).map(x => [x.id, x]));
    const rows = new Map<string, NativeSessionSummary>(sessions.map(session => [session.id, {
      session, messageCount: 0, toolCount: 0, runCount: 0,
      chat: session.chatId ? chats.get(session.chatId) : undefined,
    }]));
    const latestUser = new Map<string, NativeMessageResource>();
    const latestPreview = new Map<string, NativeMessageResource>();
    for (const message of await this.repository.list<NativeMessageResource>('message')) {
      const row = message.sessionId ? rows.get(message.sessionId) : undefined;
      if (!row) continue;
      row.messageCount++; if (message.role === 'tool') row.toolCount++;
      advance(row.session, message.occurredAt);
      const user = message.actorIdentityId ? identities.get(message.actorIdentityId) : undefined;
      if (message.role === 'user' && user?.kind === 'user' && later(message, latestUser.get(row.session.id))) {
        row.lastUser = user; latestUser.set(row.session.id, message);
      }
      if (message.content.available && message.content.text && later(message, latestPreview.get(row.session.id))) {
        row.preview = message.content.text.slice(0, 500); latestPreview.set(row.session.id, message);
      }
    }
    for (const run of await this.repository.list('run')) {
      if (run.resourceType !== 'run' || !run.sessionId) continue;
      const row = rows.get(run.sessionId); if (!row) continue;
      row.runCount++; advance(row.session, run.completedAt ?? run.startedAt);
    }
    for (const row of rows.values()) {
      row.owner = row.chat?.ownerIdentityId ? identities.get(row.chat.ownerIdentityId) : undefined;
      // A sole observed human is an honest fallback. Never choose an arbitrary group member.
      if (!row.lastUser) {
        const humans = row.session.participantIdentityIds.map(id => identities.get(id)).filter(x => x?.kind === 'user');
        if (humans.length === 1) row.lastUser = humans[0];
      }
    }
    this.summaries = [...rows.values()].sort((a, b) => Date.parse(b.session.lastActivityAt) - Date.parse(a.session.lastActivityAt)
      || a.session.id.localeCompare(b.session.id));
    this.generation = generation;
    return this.summaries;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined); return next;
  }
  private invalidate(type: string): void {
    if (['session', 'identity', 'chat', 'message', 'run'].includes(type)) this.summaryRevision++;
  }
}

function advance(session: NativeSessionResource, time?: string): void {
  if (time && Date.parse(time) > Date.parse(session.lastActivityAt)) session.lastActivityAt = time;
}
function later(a: NativeMessageResource, b?: NativeMessageResource): boolean {
  return !b || Date.parse(a.occurredAt) > Date.parse(b.occurredAt)
    || (Date.parse(a.occurredAt) === Date.parse(b.occurredAt) && a.id > b.id);
}

/** Mirrors committed events, not model input. The source remains the only authoritative writer. */
export function observeNativeRepository(repository: NativeReadRepository,
  accept: (change: NativeReadChange) => Promise<void>): NativeReadRepository {
  return {
    profileId: repository.profileId, initialize: () => repository.initialize(),
    currentCursor: () => repository.currentCursor(), get: (type, id) => repository.get(type, id),
    list: type => repository.list(type), changes: (after, limit) => repository.changes(after, limit),
    upsert: async input => { const change = await repository.upsert(input); await accept(change); return change; },
    delete: async input => { const change = await repository.delete(input); await accept(change); return change; },
  };
}

export function snapshotChange(resource: NativeReadResource): NativeReadChange {
  return { cursor: '', eventId: `bootstrap:${resource.resourceType}:${resource.id}:${resource.revision}`,
    changedAt: resource.updatedAt, operation: 'upsert', resourceType: resource.resourceType,
    resourceId: resource.id, revision: resource.revision, resource };
}
