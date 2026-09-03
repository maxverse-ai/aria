import { describe, expect, it, vi } from 'vitest';
import type { TriggerDefinition } from '../../../src/trigger/state';
import {
  InMemoryTriggerStateStore,
  TRIGGER_STATE_SCHEMA_VERSION,
} from '../../../src/trigger/state';
import { TriggerProviderRegistry } from '../../../src/trigger/plugin';
import {
  InMemorySyntheticEventSource,
  createSyntheticTriggerProvider,
  type SyntheticTriggerConfig,
} from '../../../src/trigger/providers';
import {
  TriggerIngressCoordinator,
  TriggerManager,
  type TriggerExecutionGateway,
} from '../../../src/trigger/runtime';

const NOW = Date.parse('2026-09-03T12:00:00Z');

describe('synthetic event Trigger ABI extension proof', () => {
  it('durably accepts, acknowledges and executes an internal event exactly once', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const submit = vi.fn<TriggerExecutionGateway['submit']>(async () => ({
      runId: 'internal-run', completion: Promise.resolve({ status: 'succeeded' }),
    }));
    let managerId = 0;
    const manager = new TriggerManager({
      enabled: true,
      store,
      execution: { isProfileOnline: () => true, submit },
      now: () => NOW,
      createId: () => `manager-${++managerId}`,
      pollIntervalMs: 60_000,
    });
    let ingressId = 0;
    const ingress = new TriggerIngressCoordinator({
      store,
      now: () => NOW,
      createId: () => `event-occurrence-${++ingressId}`,
    });
    const source = new InMemorySyntheticEventSource();
    const registry = new TriggerProviderRegistry();
    registry.register(createSyntheticTriggerProvider(source));
    const runtime = await registry.start('synthetic-event', {
      instance: instance(),
      ingress,
      signal: new AbortController().signal,
    });

    const event = { id: 'source-event-42', occurredAt: NOW - 1_000, data: { kind: 'repository.changed' } };
    await expect(source.publish(event)).resolves.toEqual([
      { status: 'accepted', receiptId: 'occurrence:event-occurrence-1' },
    ]);
    await expect(source.publish(event)).resolves.toEqual([
      { status: 'duplicate', receiptId: 'occurrence:event-occurrence-1' },
    ]);

    await manager.reconcile();
    await manager.drain();

    expect(await store.listOccurrences()).toEqual([
      expect.objectContaining({
        id: 'event-occurrence-1',
        state: 'succeeded',
        scheduledFor: NOW,
        metadata: expect.objectContaining({ sourceEventId: 'source-event-42', occurredAt: String(NOW - 1_000) }),
      }),
    ]);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith('profile-a', expect.objectContaining({
      sourceKind: 'internal-event',
      sourceIdentity: { providerId: 'synthetic-event', sourceEventId: 'source-event-42' },
      actor: { kind: 'system', actorRef: 'definition-authority' },
      input: { prompt: 'inspect the accepted event', attachments: [] },
      correlation: expect.objectContaining({
        attributes: expect.objectContaining({ sourceEventId: 'source-event-42' }),
      }),
    }));
    expect(runtime.snapshot()).toMatchObject({ state: 'ready', acceptingEvents: true });
    await registry.closeAll();
    expect(source.listenerCount()).toBe(0);
  });

  it('rejects provider evidence that attempts to select another durable scope', async () => {
    const store = new InMemoryTriggerStateStore();
    await store.createDefinition(definition());
    const ingress = new TriggerIngressCoordinator({ store, now: () => NOW });
    const source = new InMemorySyntheticEventSource();
    const registry = new TriggerProviderRegistry();
    registry.register(createSyntheticTriggerProvider(source));
    await registry.start('synthetic-event', {
      instance: instance({ scopeRef: 'other-scope' }),
      ingress,
      signal: new AbortController().signal,
    });

    await expect(source.publish({ id: 'event-1', occurredAt: NOW, data: null }))
      .rejects.toMatchObject({ code: 'source-binding-mismatch' });
    expect(await store.listOccurrences()).toEqual([]);
    await registry.closeAll();
  });

  it('drains and closes the push source without accepting later events', async () => {
    const source = new InMemorySyntheticEventSource();
    const registry = new TriggerProviderRegistry();
    registry.register(createSyntheticTriggerProvider(source));
    const runtime = await registry.start('synthetic-event', {
      instance: instance(),
      ingress: { accept: async () => ({ status: 'accepted', receiptId: 'receipt-1' }) },
      signal: new AbortController().signal,
    });

    await expect(runtime.drain({ deadlineAt: Date.now() + 1_000 }))
      .resolves.toEqual({ drained: true, remainingEvents: 0 });
    expect(runtime.snapshot()).toMatchObject({ state: 'draining', acceptingEvents: false });
    expect(await source.publish({ id: 'late', occurredAt: NOW, data: {} })).toEqual([]);
    await runtime.close();
    expect(runtime.snapshot()).toMatchObject({ state: 'stopped', acceptingEvents: false });
  });
});

function instance(overrides: Partial<SyntheticTriggerConfig> = {}) {
  return {
    profileId: 'profile-a',
    providerId: 'synthetic-event',
    instanceId: 'primary',
    enabled: true,
    configVersion: 1,
    config: {
      definitionId: 'definition-a',
      scopeRef: 'scope-a',
      actorRef: 'synthetic-source',
      ...overrides,
    },
    secretRefs: {},
  } as const;
}

function definition(): TriggerDefinition {
  return {
    schemaVersion: TRIGGER_STATE_SCHEMA_VERSION,
    id: 'definition-a', profileId: 'profile-a', providerId: 'synthetic-event', instanceId: 'primary',
    sourceKind: 'internal-event', state: 'active', revision: 1,
    ownerRef: 'system-a', createdBy: { kind: 'system', actorRef: 'system-a' },
    authorizationGrantRef: 'grant-a',
    authorizationCeiling: {
      maxRuntimeMs: 60_000, maxAttemptsPerOccurrence: 3, allowWakeProfile: false,
      allowedResultRouteIds: ['history'],
    },
    triggerSpec: { eventType: 'repository.changed' },
    intentTemplate: {
      actor: { kind: 'system', actorRef: 'definition-authority' },
      authorizationRef: 'grant-a', scopeRef: 'scope-a', sessionPolicy: { kind: 'fresh' },
      input: { prompt: 'inspect the accepted event', attachments: [] },
      workspaceRef: { kind: 'profile-default' },
      engineRequirements: { inputs: ['text'], capabilities: [] },
      resultRoutes: [{ kind: 'history', routeId: 'history' }],
    },
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0 },
    quota: { maxActiveOccurrences: 1, maxRunsPerDay: 24 },
    misfirePolicy: 'coalesce', overlapPolicy: { kind: 'queue-one' },
    createdAt: 1, updatedAt: 1, metadata: {},
  };
}
