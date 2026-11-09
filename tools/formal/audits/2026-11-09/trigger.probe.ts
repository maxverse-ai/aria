// Historical evidence: assertions describe the audited baseline, not desired behavior.
import { describe, expect, it } from 'vitest';
import { InMemoryTriggerStateStore, createPendingOccurrence, type TriggerDefinition } from '../../../../src/trigger/state';
import { TriggerManager } from '../../../../src/trigger/runtime';
import { InMemoryTriggerResultDeliveryStore, TriggerResultRouter } from '../../../../src/trigger/result';

const at = 1_000_000;
function definition(): TriggerDefinition {
  return {
    schemaVersion: 1, id: 'd', profileId: 'p', providerId: 'schedule', instanceId: 'clock',
    sourceKind: 'schedule', state: 'active', revision: 1, ownerRef: 'user',
    createdBy: { kind: 'user', actorRef: 'user' }, authorizationGrantRef: 'grant',
    authorizationCeiling: { maxRuntimeMs: 100, maxAttemptsPerOccurrence: 3, allowWakeProfile: false, allowedResultRouteIds: ['conversation'] },
    triggerSpec: { schedule: { kind: 'once', at: new Date(at).toISOString() }, timeZone: 'UTC' },
    intentTemplate: {
      actor: { kind: 'system', actorRef: 'clock' }, authorizationRef: 'grant', scopeRef: 'scope',
      sessionPolicy: { kind: 'fresh' }, input: { prompt: 'isolated audit', attachments: [] },
      workspaceRef: { kind: 'profile-default' }, engineRequirements: { inputs: ['text'], capabilities: [] },
      resultRoutes: [{ kind: 'conversation', routeId: 'conversation', conversationRef: 'scope' }],
    },
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 },
    quota: { maxActiveOccurrences: 1, maxRunsPerDay: 1 }, misfirePolicy: 'coalesce', overlapPolicy: { kind: 'queue-one' },
    nextFireAt: at, createdAt: 1, updatedAt: 1, metadata: {},
  };
}
const success = () => Promise.resolve({ status: 'succeeded' as const, output: { text: 'done' } });
describe('2026-11-09 trigger audit evidence', () => {
  it('does not reconstruct a result that failed before its first durable checkpoint', async () => {
    const store = new InMemoryTriggerStateStore(); await store.createDefinition(definition());
    const deliveries = new InMemoryTriggerResultDeliveryStore();
    let routes = 0;
    const router = new TriggerResultRouter({ store: deliveries,
      resolver: { resolve: async () => { routes++; throw new Error('isolated resolver failure'); } },
      channel: { deliver: async intent => ({ deliveryId: intent.deliveryId, status: 'sent', deliveredAt: at }) },
    });
    let id = 0;
    const manager = new TriggerManager({ enabled: true, store, now: () => at, createId: () => `id-${++id}`,
      execution: { isProfileOnline: () => true, submit: async () => ({ runId: 'run', completion: success() }) }, results: router });
    await manager.reconcile(); await manager.drain(); await manager.reconcile();
    expect((await store.listOccurrences())[0]?.state).toBe('succeeded');
    expect(await deliveries.listReady(at)).toEqual([]);
    expect(routes).toBe(1);
  });

  it('concurrent result reconciliation invokes the channel twice for one delivery', async () => {
    const store = new InMemoryTriggerResultDeliveryStore();
    await store.create({ schemaVersion: 1, deliveryId: 'one', occurrenceId: 'o', routeId: 'r', state: 'pending', attempt: 0,
      intent: { abiVersion: 1, deliveryId: 'one', profileId: 'p', pluginId: 'fake', instanceId: 'i', scopeId: 's', content: { kind: 'text', text: 'isolated' } }, createdAt: at, updatedAt: at });
    let calls = 0; let both!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { both = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const router = new TriggerResultRouter({ store, resolver: { resolve: async () => { throw new Error('unused'); } },
      channel: { deliver: async intent => { if (++calls === 2) both(); await barrier; return { deliveryId: intent.deliveryId, status: 'sent', deliveredAt: at }; } } });
    const first = router.reconcile(); const second = router.reconcile();
    await entered; release(); await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect((await store.get('one'))?.attempt).toBe(1);
  });

  it('reclaims expired running work but cannot transition it back into dispatch', async () => {
    const store = new InMemoryTriggerStateStore(); await store.createDefinition(definition());
    let now = at; let submits = 0; let id = 0;
    const manager = new TriggerManager({ enabled: true, store, now: () => now, createId: () => `id-${++id}`, leaseDurationMs: 10,
      execution: { isProfileOnline: () => true, submit: async () => { submits++; return { runId: 'run', completion: new Promise(() => {}) }; } } });
    await manager.reconcile();
    now += 111;
    await expect(manager.reconcile()).rejects.toThrow('running -> dispatching');
    expect((await store.listOccurrences())[0]?.state).toBe('running');
    expect(submits).toBe(1);
  });

  it('dispatches two same-day occurrences despite maxRunsPerDay of one', async () => {
    const store = new InMemoryTriggerStateStore(); await store.createDefinition(definition());
    let submits = 0; let id = 0;
    const manager = new TriggerManager({ enabled: true, store, now: () => at + 10, createId: () => `id-${++id}`,
      execution: { isProfileOnline: () => true, submit: async () => ({ runId: `run-${++submits}`, completion: success() }) } });
    await manager.reconcile(); await manager.drain();
    await store.materialize({ definitionId: 'd', expectedRevision: 1, advancedAt: at + 10,
      occurrence: createPendingOccurrence({ id: 'second', profileId: 'p', definitionId: 'd', definitionRevision: 1, scheduledFor: at + 1, createdAt: at + 1 }) });
    await manager.reconcile(); await manager.drain();
    expect(submits).toBe(2);
  });
});
