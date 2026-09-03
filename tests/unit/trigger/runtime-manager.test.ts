import { describe, expect, it, vi } from 'vitest';
import type { TriggerDefinition } from '../../../src/trigger/state';
import {
  InMemoryTriggerStateStore,
  TRIGGER_STATE_SCHEMA_VERSION,
} from '../../../src/trigger/state';
import {
  TriggerManager,
  type TriggerExecutionGateway,
} from '../../../src/trigger/runtime';

const FIRE_AT = Date.parse('2026-09-03T08:00:00Z');

describe('TriggerManager single-run data path', () => {
  it('materializes and dispatches one-time history work through the execution gateway', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const submit = vi.fn<TriggerExecutionGateway['submit']>(async () => ({
      runId: 'run-a',
      completion: Promise.resolve({ status: 'succeeded' }),
    }));
    const manager = managerFor(store, { isProfileOnline: () => true, submit });

    await manager.reconcile();

    const occurrences = await store.listOccurrences();
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      state: 'succeeded',
      attempt: 1,
      dispatch: { intentId: 'id-3', runId: 'run-a' },
    });
    expect((await store.getDefinition('definition-a'))?.nextFireAt).toBeUndefined();
    expect(submit).toHaveBeenCalledWith('profile-a', expect.objectContaining({
      intentId: 'id-3',
      sourceKind: 'schedule',
      idempotencyKey: `profile-a\u001fdefinition-a\u001f${FIRE_AT}`,
      correlation: expect.objectContaining({ requestId: 'id-1' }),
    }));
    expect(manager.snapshot()).toMatchObject({
      materialized: 1, dispatched: 1, succeeded: 1, failed: 0,
    });
  });

  it('is inert unless the rollout switch is explicitly enabled', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const submit = vi.fn<TriggerExecutionGateway['submit']>();
    const manager = new TriggerManager({
      store,
      execution: { isProfileOnline: () => true, submit },
      now: () => FIRE_AT,
    });

    manager.start();
    await manager.reconcile();

    expect(await store.listOccurrences()).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
    expect(manager.snapshot()).toMatchObject({ enabled: false, running: false });
  });

  it('keeps due work deferred and visible when the profile is offline', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const submit = vi.fn<TriggerExecutionGateway['submit']>();
    const manager = managerFor(store, { isProfileOnline: () => false, submit });

    await manager.reconcile();

    expect(await store.listOccurrences()).toEqual([
      expect.objectContaining({ state: 'deferred', blockedCode: 'profile-offline' }),
    ]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('persists a bounded retry instead of losing a failed submission', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const manager = managerFor(store, {
      isProfileOnline: () => true,
      submit: async () => { throw Object.assign(new Error('busy'), { code: 'engine-busy' }); },
    });

    await manager.reconcile();

    expect(await store.listOccurrences()).toEqual([
      expect.objectContaining({
        state: 'retry-wait', attempt: 1,
        failure: expect.objectContaining({ kind: 'transient', code: 'engine-busy' }),
      }),
    ]);
  });

  it('fails closed when a Stage 5 definition asks for proactive delivery', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition({
      authorizationCeiling: {
        maxRuntimeMs: 60_000, maxAttemptsPerOccurrence: 3, allowWakeProfile: false,
        allowedResultRouteIds: ['conversation'],
      },
      intentTemplate: {
        ...definition().intentTemplate,
        resultRoutes: [{ kind: 'conversation', routeId: 'conversation', conversationRef: 'opaque-scope' }],
      },
    }));
    const submit = vi.fn<TriggerExecutionGateway['submit']>();
    const manager = managerFor(store, { isProfileOnline: () => true, submit });

    await manager.reconcile();

    expect(await store.listOccurrences()).toEqual([
      expect.objectContaining({
        state: 'dead',
        failure: expect.objectContaining({ code: 'result-route-unsupported' }),
      }),
    ]);
    expect(submit).not.toHaveBeenCalled();
  });
});

function managerFor(store: InMemoryTriggerStateStore, execution: TriggerExecutionGateway) {
  let id = 0;
  return new TriggerManager({
    enabled: true,
    store,
    execution,
    now: () => FIRE_AT,
    createId: () => `id-${++id}`,
    pollIntervalMs: 60_000,
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
    triggerSpec: { schedule: { kind: 'once', at: new Date(FIRE_AT).toISOString() }, timeZone: 'UTC' },
    intentTemplate: {
      actor: { kind: 'system', actorRef: 'schedule' }, authorizationRef: 'grant-a', scopeRef: 'scope-a',
      sessionPolicy: { kind: 'fresh' }, input: { prompt: 'run the report', attachments: [] },
      workspaceRef: { kind: 'profile-default' }, engineRequirements: { inputs: ['text'], capabilities: [] },
      resultRoutes: [{ kind: 'history', routeId: 'history' }],
    },
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0 },
    quota: { maxActiveOccurrences: 1, maxRunsPerDay: 24 },
    misfirePolicy: 'coalesce', overlapPolicy: { kind: 'queue-one' }, nextFireAt: FIRE_AT,
    createdAt: 1, updatedAt: 1, metadata: {},
    ...overrides,
  };
}
