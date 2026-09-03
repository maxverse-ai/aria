import { describe, expect, it } from 'vitest';
import type { TriggerDefinition, TriggerStateStore } from '../../../src/trigger/state';
import {
  InMemoryTriggerStateStore,
  TRIGGER_STATE_SCHEMA_VERSION,
  TriggerStateError,
  createPendingOccurrence,
  triggerOccurrenceIdempotencyKey,
  triggerRetryDelay,
} from '../../../src/trigger/state';

describe('TriggerStateStore', () => {
  it('atomically materializes one logical occurrence and advances the schedule cursor', async () => {
    const store = await activeStore();
    const occurrence = pending('occurrence-a', 100);
    const input = {
      definitionId: 'definition-a', expectedRevision: 1, expectedNextFireAt: 100,
      occurrence, nextFireAt: 200, advancedAt: 101,
    };

    const results = await Promise.all([store.materialize(input), store.materialize(input)]);
    expect(results.map((item) => item.status).sort()).toEqual(['created', 'duplicate']);
    expect(await store.listOccurrences()).toHaveLength(1);
    expect(await store.getDefinition('definition-a')).toMatchObject({ nextFireAt: 200, scheduleAdvancedAt: 101 });
    await expect(store.materialize({ ...input, occurrence: pending('occurrence-b', 150), expectedNextFireAt: 100 }))
      .rejects.toMatchObject({ code: 'revision-conflict' });
  });

  it('uses semantic revision CAS and never revives a canceled definition', async () => {
    const store = new InMemoryTriggerStateStore();
    const created = await store.createDefinition(definition({ state: 'draft', nextFireAt: undefined }));
    (created.metadata as Record<string, string>).changed = 'outside';
    expect((await store.getDefinition('definition-a'))?.metadata).toEqual({ fixture: 'true' });

    const active = definition({ state: 'active', revision: 2, updatedAt: 2 });
    await expect(store.replaceDefinition(active, 1)).resolves.toMatchObject({ state: 'active', revision: 2 });
    await expect(store.replaceDefinition({ ...active, revision: 3 }, 1)).rejects.toMatchObject({ code: 'revision-conflict' });
    const canceled = { ...active, state: 'canceled' as const, revision: 3, updatedAt: 3, canceledAt: 3 };
    await store.replaceDefinition(canceled, 2);
    await expect(store.replaceDefinition({ ...canceled, state: 'active', revision: 4, updatedAt: 4 }, 3))
      .rejects.toMatchObject({ code: 'invalid-definition-transition' });
  });

  it('fences expired workers and recovers an ambiguous dispatch checkpoint', async () => {
    const store = await materializedStore();
    const first = await claim(store, 100, 'lease-a', 'worker-a');
    const dispatching = await store.beginDispatch(first.id, lease(first), 'intent-a', 101);
    expect(dispatching.state).toBe('dispatching');
    expect(await store.claimNext({ now: 109, leaseId: 'early', leaseOwner: 'worker-b', leaseDurationMs: 10 })).toBeUndefined();
    await expect(store.markRunning(first.id, lease(first), 'run-expired', 110))
      .rejects.toMatchObject({ code: 'expired-lease' });

    const recovered = await store.claimNext({ now: 110, leaseId: 'lease-b', leaseOwner: 'worker-b', leaseDurationMs: 10 });
    expect(recovered).toMatchObject({ state: 'dispatching', attempt: 1, fence: 2, dispatch: { intentId: 'intent-a' } });
    await expect(store.markRunning(first.id, lease(first), 'run-stale', 111))
      .rejects.toMatchObject({ code: 'stale-lease' });
    const running = await store.markRunning(recovered!.id, lease(recovered!), 'run-a', 111);
    await expect(store.markSucceeded(running.id, lease(running), 112)).resolves.toMatchObject({
      state: 'succeeded', completedAt: 112, dispatch: { intentId: 'intent-a', runId: 'run-a' },
    });
  });

  it('persists bounded retries, then moves exhausted work to dead', async () => {
    const store = await materializedStore();
    let current = await claim(store, 100, 'lease-1', 'worker');
    const failure = { kind: 'transient' as const, code: 'provider-busy', recordedAt: 101 };
    current = await store.scheduleRetry({ occurrenceId: current.id, lease: lease(current), failure, now: 101 });
    expect(current).toMatchObject({ state: 'retry-wait', attempt: 1 });
    expect(current.nextAttemptAt).toBe(106);

    current = (await store.claimNext({ now: 106, leaseId: 'lease-2', leaseOwner: 'worker', leaseDurationMs: 10 }))!;
    current = await store.scheduleRetry({ occurrenceId: current.id, lease: lease(current), failure: { ...failure, recordedAt: 107 }, now: 107 });
    expect(current).toMatchObject({ state: 'retry-wait', attempt: 2, nextAttemptAt: 112 });

    current = (await store.claimNext({ now: 112, leaseId: 'lease-3', leaseOwner: 'worker', leaseDurationMs: 10 }))!;
    current = await store.scheduleRetry({ occurrenceId: current.id, lease: lease(current), failure: { ...failure, recordedAt: 113 }, now: 113 });
    expect(current).toMatchObject({ state: 'dead', attempt: 3, completedAt: 113 });
    expect(current).not.toHaveProperty('lease');
    await expect(store.acknowledgeDead(current.id, 114)).resolves.toMatchObject({ deadAcknowledgedAt: 114 });
    await expect(store.cleanup({ completedBefore: 115, limit: 10 })).resolves.toEqual([current.id]);
  });

  it('keeps deferred work visible until its blocking condition is explicitly reconsidered', async () => {
    const store = await materializedStore();
    const claimed = await claim(store, 100, 'lease-a', 'worker');
    await expect(store.markDeferred(claimed.id, lease(claimed), 'profile-stopped', 101))
      .resolves.toMatchObject({ state: 'deferred', blockedCode: 'profile-stopped' });
    expect(await store.claimNext({ now: 1_000, leaseId: 'lease-b', leaseOwner: 'worker', leaseDurationMs: 10 })).toBeUndefined();
    await store.resumeDeferred(claimed.id, 1_001);
    await expect(store.claimNext({ now: 1_001, leaseId: 'lease-c', leaseOwner: 'worker', leaseDurationMs: 10 }))
      .resolves.toMatchObject({ state: 'leased', attempt: 2 });
  });

  it('derives restart-stable idempotency and retry values', () => {
    expect(triggerOccurrenceIdempotencyKey('profile-a', 'definition-a', 100))
      .toBe('profile-a\u001fdefinition-a\u001f100');
    expect(triggerRetryDelay('occurrence-a', 2, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 }))
      .toBe(20);
  });
});

async function activeStore(): Promise<InMemoryTriggerStateStore> {
  const store = new InMemoryTriggerStateStore();
  await store.createDefinition(definition());
  return store;
}

async function materializedStore(): Promise<InMemoryTriggerStateStore> {
  const store = await activeStore();
  await store.materialize({
    definitionId: 'definition-a', expectedRevision: 1, expectedNextFireAt: 100,
    occurrence: pending('occurrence-a', 100), nextFireAt: 200, advancedAt: 100,
  });
  return store;
}

async function claim(store: TriggerStateStore, now: number, leaseId: string, leaseOwner: string) {
  return (await store.claimNext({ now, leaseId, leaseOwner, leaseDurationMs: 10 }))!;
}

function lease(occurrence: { lease?: { leaseId: string; token: number } }) {
  if (!occurrence.lease) throw new Error('fixture occurrence is not leased');
  return { leaseId: occurrence.lease.leaseId, token: occurrence.lease.token };
}

function pending(id: string, scheduledFor: number) {
  return createPendingOccurrence({
    id, profileId: 'profile-a', definitionId: 'definition-a', definitionRevision: 1,
    scheduledFor, createdAt: scheduledFor,
  });
}

function definition(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
  return {
    schemaVersion: TRIGGER_STATE_SCHEMA_VERSION,
    id: 'definition-a', profileId: 'profile-a', providerId: 'schedule', instanceId: 'host-clock',
    sourceKind: 'schedule', state: 'active', revision: 1,
    ownerRef: 'user-a', createdBy: { kind: 'user', actorRef: 'user-a' },
    authorizationGrantRef: 'grant-a',
    authorizationCeiling: {
      maxRuntimeMs: 60_000, maxAttemptsPerOccurrence: 3, allowWakeProfile: false,
      allowedResultRouteIds: ['history'],
    },
    triggerSpec: { schedule: { kind: 'daily', at: { hour: 9, minute: 0 } }, timeZone: 'UTC' },
    intentTemplate: {
      actor: { kind: 'system', actorRef: 'schedule' }, authorizationRef: 'grant-a', scopeRef: 'scope-a',
      sessionPolicy: { kind: 'fresh' }, input: { prompt: 'run the report', attachments: [] },
      workspaceRef: { kind: 'profile-default' }, engineRequirements: { inputs: ['text'], capabilities: [] },
      resultRoutes: [{ kind: 'history', routeId: 'history' }],
    },
    retryPolicy: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 },
    quota: { maxActiveOccurrences: 1, maxRunsPerDay: 24 },
    misfirePolicy: 'coalesce', overlapPolicy: { kind: 'queue-one' }, nextFireAt: 100,
    createdAt: 1, updatedAt: 1, metadata: { fixture: 'true' },
    ...overrides,
  };
}
