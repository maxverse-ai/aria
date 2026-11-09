import { describe, expect, it, vi } from 'vitest';
import type { TriggerDefinition } from '../../../src/trigger/state';
import {
  InMemoryTriggerStateStore,
  TRIGGER_STATE_SCHEMA_VERSION,
} from '../../../src/trigger/state';
import {
  TriggerManager,
  TriggerExecutionNotAcceptedError,
  type TriggerExecutionGateway,
} from '../../../src/trigger/runtime';

const FIRE_AT = Date.parse('2026-09-03T08:00:00Z');

describe('TriggerManager single-run data path', () => {
  it('retains accepted work as unknown when running checkpoint fails and consumes completion rejection', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    vi.spyOn(store, 'markRunning').mockRejectedValue(new Error('disk unavailable'));
    const submit = vi.fn<TriggerExecutionGateway['submit']>(async () => ({ runId: 'accepted-run',
      completion: Promise.reject(new Error('lost observer')) }));
    const manager = managerFor(store, { isProfileOnline: () => true, submit });
    await manager.reconcile(); await manager.drain(); await manager.reconcile();
    expect(submit).toHaveBeenCalledOnce();
    expect(await store.listOccurrences()).toMatchObject([{ state: 'deferred', blockedCode: 'execution-outcome-unknown' }]);
    await manager.close();
  });

  it.each(['submission', 'observer'])('retains unknown %s outcome without replaying accepted work', async phase => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const submit = vi.fn<TriggerExecutionGateway['submit']>(async () => {
      if (phase === 'submission') throw new Error('response lost after acceptance');
      return { runId: 'accepted', completion: Promise.reject(new Error('observer disconnected')) };
    });
    const manager = managerFor(store, { isProfileOnline: () => true, submit });
    await manager.reconcile(); await manager.drain(); await manager.reconcile();
    expect(submit).toHaveBeenCalledOnce();
    expect(await store.listOccurrences()).toMatchObject([{ state: 'deferred',
      blockedCode: 'execution-outcome-unknown', dispatch: { intentId: expect.any(String) } }]);
    await manager.close();
  });

  it('never retries agent work when a successful completion checkpoint fails', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    vi.spyOn(store, 'markSucceeded').mockRejectedValue(new Error('disk unavailable'));
    const retry = vi.spyOn(store, 'scheduleRetry');
    const submit = vi.fn<TriggerExecutionGateway['submit']>(async () => ({
      runId: 'completed-run', completion: Promise.resolve({ status: 'succeeded', output: { text: 'durable result' } }),
    }));
    const manager = managerFor(store, { isProfileOnline: () => true, submit });
    await manager.reconcile(); await manager.drain();
    expect(submit).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect((await store.listOccurrences())[0]).toMatchObject({ state: 'running', dispatch: { runId: 'completed-run' } });
    await manager.close();
  });

  it('holds profile admission durably until the final owner releases', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const submit = vi.fn<TriggerExecutionGateway['submit']>(async () => ({
      runId: 'held-run', completion: Promise.resolve({ status: 'succeeded' }),
    }));
    const manager = managerFor(store, { isProfileOnline: () => true, submit });
    const releaseFirst = manager.pauseProfileAdmission('profile-a');
    const releaseSecond = manager.pauseProfileAdmission('profile-a');
    await manager.reconcile();
    await manager.waitProfileIdle('profile-a', 1000);
    expect(submit).not.toHaveBeenCalled();
    expect(await store.listOccurrences()).toMatchObject([{ state: 'deferred', blockedCode: 'profile-updating' }]);
    releaseFirst(); releaseFirst();
    await manager.reconcile();
    expect(submit).not.toHaveBeenCalled();
    releaseSecond();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await manager.close();
  });

  it('drain waits for submitted completion and rejects rather than claiming idle on timeout', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    let finish!: (result: { status: 'succeeded' }) => void;
    const completion = new Promise<{ status: 'succeeded' }>(resolve => { finish = resolve; });
    const manager = managerFor(store, { isProfileOnline: () => true,
      submit: async () => ({ runId: 'active-run', completion }) });
    await manager.reconcile();
    const release = manager.pauseProfileAdmission('profile-a');
    await expect(manager.waitProfileIdle('profile-a', 10)).rejects.toThrow('trigger-profile-drain-timeout');
    finish({ status: 'succeeded' });
    await manager.waitProfileIdle('profile-a', 1000);
    expect(await store.listOccurrences()).toMatchObject([{ state: 'succeeded' }]);
    release();
    await manager.close();
  });

  it('checks the admission hold again after durable preparation before submission', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const submit = vi.fn<TriggerExecutionGateway['submit']>();
    const manager = managerFor(store, { isProfileOnline: () => true, submit });
    let release!: () => void;
    const begin = store.beginDispatch.bind(store);
    vi.spyOn(store, 'beginDispatch').mockImplementation(async (...args) => {
      const result = await begin(...args);
      release = manager.pauseProfileAdmission('profile-a');
      return result;
    });
    await manager.reconcile();
    await manager.waitProfileIdle('profile-a', 1000);
    expect(submit).not.toHaveBeenCalled();
    expect(await store.listOccurrences()).toMatchObject([{ state: 'deferred', blockedCode: 'profile-updating' }]);
    await manager.close();
    release();
  });

  it('materializes and dispatches one-time history work through the execution gateway', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const submit = vi.fn<TriggerExecutionGateway['submit']>(async () => ({
      runId: 'run-a',
      completion: Promise.resolve({ status: 'succeeded' }),
    }));
    const manager = managerFor(store, { isProfileOnline: () => true, submit });

    await manager.reconcile();
    await manager.drain();

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

  it('coalesces a sleeping host into one current daily occurrence', async () => {
    const first = Date.parse('2026-09-01T09:00:00Z');
    const now = Date.parse('2026-09-03T12:00:00Z');
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition({
      triggerSpec: { schedule: { kind: 'daily', at: { hour: 9, minute: 0 } }, timeZone: 'UTC' },
      nextFireAt: first,
    }));
    const manager = managerFor(store, {
      isProfileOnline: () => true,
      submit: async () => ({ runId: 'daily-run', completion: Promise.resolve({ status: 'succeeded' }) }),
    }, () => now);

    await manager.reconcile();
    await manager.drain();

    expect(await store.listOccurrences()).toEqual([
      expect.objectContaining({ scheduledFor: Date.parse('2026-09-03T09:00:00Z'), state: 'succeeded' }),
    ]);
    expect(await store.getDefinition('definition-a')).toMatchObject({
      revision: 1,
      nextFireAt: Date.parse('2026-09-04T09:00:00Z'),
    });
    expect(manager.snapshot()).toMatchObject({ materialized: 1, coalesced: 2 });
  });

  it('advances skipped recurring work without manufacturing a semantic edit', async () => {
    const first = Date.parse('2026-09-01T09:00:00Z');
    const now = Date.parse('2026-09-03T12:00:00Z');
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition({
      triggerSpec: { schedule: { kind: 'daily', at: { hour: 9, minute: 0 } }, timeZone: 'UTC' },
      nextFireAt: first,
      misfirePolicy: 'skip',
    }));
    const submit = vi.fn<TriggerExecutionGateway['submit']>();
    const manager = managerFor(store, { isProfileOnline: () => true, submit }, () => now);

    await manager.reconcile();

    expect(await store.listOccurrences()).toEqual([]);
    expect(await store.getDefinition('definition-a')).toMatchObject({
      revision: 1,
      nextFireAt: Date.parse('2026-09-04T09:00:00Z'),
    });
    expect(manager.snapshot()).toMatchObject({ skipped: 3 });
  });

  it('resumes an offline profile occurrence when that profile comes back', async () => {
    let online = false;
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const submit = vi.fn<TriggerExecutionGateway['submit']>(async () => ({
      runId: 'resumed-run', completion: Promise.resolve({ status: 'succeeded' }),
    }));
    const manager = managerFor(store, { isProfileOnline: () => online, submit });
    await manager.reconcile();
    expect((await store.listOccurrences())[0]).toMatchObject({ state: 'deferred', blockedCode: 'profile-offline' });

    online = true;
    await expect(manager.resumeProfile('profile-a')).resolves.toBe(1);
    await manager.drain();

    expect((await store.listOccurrences())[0]).toMatchObject({ state: 'succeeded', attempt: 2 });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate work when the wall clock moves backward', async () => {
    let now = FIRE_AT;
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const manager = managerFor(store, {
      isProfileOnline: () => true,
      submit: async () => ({ runId: 'run-a', completion: Promise.resolve({ status: 'succeeded' }) }),
    }, () => now);

    await manager.reconcile();
    await manager.drain();
    now -= 60_000;
    await manager.reconcile();

    expect(await store.listOccurrences()).toHaveLength(1);
    expect(manager.snapshot().clockJumps).toBe(1);
  });

  it('queues one overlapping occurrence and dispatches it after the active run', async () => {
    let now = Date.parse('2026-09-01T09:00:00Z');
    let resolveFirst!: (result: { status: 'succeeded' }) => void;
    const firstCompletion = new Promise<{ status: 'succeeded' }>((resolve) => { resolveFirst = resolve });
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition({
      triggerSpec: { schedule: { kind: 'cron', expression: '* * * * *' }, timeZone: 'UTC' },
      nextFireAt: now,
      quota: { maxActiveOccurrences: 2, maxRunsPerDay: 24 },
    }));
    const submit = vi.fn<TriggerExecutionGateway['submit']>()
      .mockResolvedValueOnce({ runId: 'run-1', completion: firstCompletion })
      .mockResolvedValueOnce({ runId: 'run-2', completion: Promise.resolve({ status: 'succeeded' }) });
    const manager = managerFor(store, { isProfileOnline: () => true, submit }, () => now);

    await manager.reconcile();
    now += 60_000;
    await manager.reconcile();
    expect(await store.listOccurrences()).toEqual([
      expect.objectContaining({ state: 'running' }),
      expect.objectContaining({ state: 'deferred', blockedCode: 'overlap-active' }),
    ]);

    resolveFirst({ status: 'succeeded' });
    await manager.drain();

    expect((await store.listOccurrences()).map((item) => item.state)).toEqual(['succeeded', 'succeeded']);
    expect(submit).toHaveBeenCalledTimes(2);
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
    await manager.drain();

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
    await manager.drain();

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
      submit: async () => { throw new TriggerExecutionNotAcceptedError('busy', 'engine-busy'); },
    });

    await manager.reconcile();
    await manager.drain();

    expect(await store.listOccurrences()).toEqual([
      expect.objectContaining({
        state: 'retry-wait', attempt: 1,
        failure: expect.objectContaining({ kind: 'transient', code: 'engine-busy' }),
      }),
    ]);
  });

  it('keeps a successful agent run terminal when result routing fails', async () => {
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
    const submit = vi.fn<TriggerExecutionGateway['submit']>(async () => ({
      runId: 'run-a',
      completion: Promise.resolve({ status: 'succeeded', output: { text: 'done' } }),
    }));
    const route = vi.fn(async (): Promise<void> => {
      throw Object.assign(new Error('offline'), { code: 'channel-offline' });
    });
    let id = 0;
    const manager = new TriggerManager({
      enabled: true,
      store,
      execution: { isProfileOnline: () => true, submit },
      results: { route, reconcile: async () => undefined },
      now: () => FIRE_AT,
      createId: () => `id-${++id}`,
      pollIntervalMs: 60_000,
    });

    await manager.reconcile();
    await manager.drain();

    expect(await store.listOccurrences()).toEqual([
      expect.objectContaining({
        state: 'succeeded',
      }),
    ]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalled();
    expect((await store.listOccurrences())[0]?.resultOutbox).toMatchObject({ text: 'done' });
    route.mockImplementation(async () => undefined);
    await manager.reconcile();
    expect((await store.listOccurrences())[0]?.resultOutbox).toBeUndefined();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(manager.snapshot()).toMatchObject({ succeeded: 1, failed: 0 });
  });
});

function managerFor(
  store: InMemoryTriggerStateStore,
  execution: TriggerExecutionGateway,
  now: () => number = () => FIRE_AT,
) {
  let id = 0;
  return new TriggerManager({
    enabled: true,
    store,
    execution,
    now,
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
