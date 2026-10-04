import { describe, expect, it } from 'vitest';
import {
  engineHistorySessionKey,
  SessionCatalogReadProjector,
} from '../../../src/application/control/session-catalog-read-projector';
import type {
  NativeReadChangePage,
  NativeReadDelete,
  NativeReadRepository,
  NativeReadUpsert,
} from '../../../src/application/control/native-read-repository';
import type {
  NativeReadChange,
  NativeReadCursor,
  NativeReadResource,
  NativeSessionResource,
} from '../../../src/application/control/native-read-types';
import type { SessionCatalogEntry } from '../../../src/session/catalog';

describe('SessionCatalogReadProjector', () => {
  it('projects Claude and Codex catalog entries without exposing native IDs', async () => {
    const repository = new MemoryRepository('demo');
    const projector = new SessionCatalogReadProjector({ profileId: 'demo', repository });
    const entries = [
      catalogEntry({ agentId: 'claude', sessionId: 'claude-secret-session' }),
      catalogEntry({ agentId: 'codex', threadId: 'codex-secret-thread', scopeId: 'oc_secret_chat' }),
    ];

    const result = await projector.project({ entries });

    expect(result).toEqual({ observed: 2, projected: 2, skipped: 0 });
    expect(repository.resources).toHaveLength(2);
    expect(JSON.stringify(repository.resources)).not.toContain('claude-secret-session');
    expect(JSON.stringify(repository.resources)).not.toContain('codex-secret-thread');
    expect(JSON.stringify(repository.resources)).not.toContain('oc_secret_chat');
    expect(repository.resources.map((resource) => resource.id)).toEqual([
      expect.stringMatching(/^ses_/),
      expect.stringMatching(/^ses_/),
    ]);
  });

  it('joins generic engine history and keeps repeat scans idempotent', async () => {
    const repository = new MemoryRepository('demo');
    const projector = new SessionCatalogReadProjector({ profileId: 'demo', repository });
    const entry = catalogEntry({ agentId: 'codex', threadId: 'thread-1' });
    const history = new Map([
      [engineHistorySessionKey('codex', 'thread-1'), { id: 'thread-1', preview: 'Architecture review', updatedAtMs: 2_000, detail: 'Codex' }],
    ]);

    await projector.project({ entries: [entry], historyBySessionKey: history });
    await projector.project({ entries: [entry], historyBySessionKey: history });
    await projector.project({ entries: [entry], historyBySessionKey: history });

    expect(repository.resources).toHaveLength(1);
    expect(repository.resources[0]).toMatchObject({
      title: 'Architecture review',
      lastActivityAt: '1970-01-01T00:00:02.000Z',
      agentKind: 'codex',
    });
    expect(repository.eventIds).toHaveLength(1);
  });

  it('preserves learned metadata without producing new events on unchanged rescans', async () => {
    const repository = new MemoryRepository('demo');
    const projector = new SessionCatalogReadProjector({ profileId: 'demo', repository });
    const entry = catalogEntry({ agentId: 'codex', threadId: 'thread-1' });
    await projector.project({ entries: [entry] });
    const { revision: _revision, ...draft } = repository.resources[0] as NativeSessionResource;
    await repository.upsert<NativeSessionResource>({
      eventId: 'learned-metadata',
      resource: {
        ...draft,
        title: 'Known title',
        summary: 'Known summary',
        participantIdentityIds: ['idn_actor'],
        lastActivityAt: '1970-01-01T00:00:04.000Z',
        updatedAt: '1970-01-01T00:00:04.000Z',
      },
    });
    const updated = { ...entry, updatedAt: 2_000 };
    await projector.project({ entries: [updated] });
    const eventCount = repository.eventIds.length;
    await projector.project({ entries: [updated] });
    await projector.project({ entries: [updated] });

    expect(repository.eventIds).toHaveLength(eventCount);
    expect(repository.resources[0]).toMatchObject({
      title: 'Known title',
      summary: 'Known summary',
      participantIdentityIds: ['idn_actor'],
      lastActivityAt: '1970-01-01T00:00:04.000Z',
    });
  });

  it('skips damaged catalog identities instead of inventing a session', async () => {
    const repository = new MemoryRepository('demo');
    const projector = new SessionCatalogReadProjector({ profileId: 'demo', repository });
    const damaged = catalogEntry({ agentId: 'codex' });

    expect(await projector.project({ entries: [damaged] })).toEqual({ observed: 1, projected: 0, skipped: 1 });
    expect(repository.resources).toEqual([]);
  });

  it('preserves the first observed creation time across later source updates', async () => {
    const repository = new MemoryRepository('demo');
    const projector = new SessionCatalogReadProjector({ profileId: 'demo', repository });
    const first = catalogEntry({ agentId: 'claude', sessionId: 'session-1', updatedAt: 1_000 });
    await projector.project({ entries: [first] });
    await projector.project({ entries: [{ ...first, updatedAt: 2_000, lastSummary: 'new summary' }] });

    expect(repository.resources.at(-1)).toMatchObject({
      createdAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:02.000Z',
      summary: 'new summary',
    });
  });

  it('preserves participants learned from message bindings across catalog refreshes', async () => {
    const repository = new MemoryRepository('demo');
    const projector = new SessionCatalogReadProjector({ profileId: 'demo', repository });
    const entry = catalogEntry({ agentId: 'codex', threadId: 'thread-1' });
    await projector.project({ entries: [entry] });
    const projected = repository.resources[0] as NativeSessionResource;
    const { revision: _revision, ...draft } = projected;
    await repository.upsert<NativeSessionResource>({
      eventId: 'message-binding',
      resource: {
        ...draft,
        updatedAt: '1970-01-01T00:00:03.000Z',
        lastActivityAt: '1970-01-01T00:00:03.000Z',
        participantIdentityIds: ['idn_actor'],
      },
    });

    await projector.project({ entries: [{ ...entry, updatedAt: 2_000 }] });

    expect(repository.resources).toEqual([
      expect.objectContaining({
        updatedAt: '1970-01-01T00:00:03.000Z',
        lastActivityAt: '1970-01-01T00:00:03.000Z',
        participantIdentityIds: ['idn_actor'],
      }),
    ]);
  });
});

class MemoryRepository implements NativeReadRepository {
  readonly resources: NativeReadResource[] = [];
  readonly eventIds: string[] = [];
  private readonly eventChanges = new Map<string, NativeReadChange>();
  constructor(readonly profileId: string) {}
  async initialize(): Promise<void> {}
  async currentCursor(): Promise<NativeReadCursor> { return 'cursor'; }
  async get<T extends NativeReadResource>(type: T['resourceType'], id: string): Promise<T | undefined> {
    return this.resources.find((item) => item.resourceType === type && item.id === id) as T | undefined;
  }
  async list<T extends NativeReadResource>(type: T['resourceType']): Promise<readonly T[]> {
    return this.resources.filter((item) => item.resourceType === type) as T[];
  }
  async upsert<T extends NativeReadResource>(input: NativeReadUpsert<T>): Promise<NativeReadChange> {
    const existingEvent = this.eventChanges.get(input.eventId);
    if (existingEvent) return existingEvent;
    const previousIndex = this.resources.findIndex(
      (item) => item.resourceType === input.resource.resourceType && item.id === input.resource.id,
    );
    const resource = {
      ...input.resource,
      revision: previousIndex >= 0 ? (this.resources[previousIndex]?.revision ?? 0) + 1 : 1,
    } as unknown as T;
    if (previousIndex >= 0) this.resources.splice(previousIndex, 1);
    this.resources.push(resource);
    this.eventIds.push(input.eventId);
    const change = changeFor(resource, input.eventId);
    this.eventChanges.set(input.eventId, change);
    return change;
  }
  async delete(_input: NativeReadDelete): Promise<NativeReadChange> { throw new Error('not implemented'); }
  async changes(_after: NativeReadCursor | null, _limit?: number): Promise<NativeReadChangePage> {
    throw new Error('not implemented');
  }
}

function changeFor(resource: NativeReadResource, eventId: string): NativeReadChange {
  return {
    cursor: 'cursor', eventId, changedAt: resource.updatedAt, operation: 'upsert',
    resourceType: resource.resourceType, resourceId: resource.id, revision: resource.revision, resource,
  };
}

function catalogEntry(overrides: Partial<SessionCatalogEntry>): SessionCatalogEntry {
  return {
    key: 'key', scopeId: 'scope-1', agentId: 'claude', cwdRealpath: '/repo',
    policyFingerprint: 'policy', status: 'active', updatedAt: 1_000, ...overrides,
  };
}
