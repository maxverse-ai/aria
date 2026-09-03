import { describe, expect, it, vi } from 'vitest';
import { runTriggerProviderContract } from '../../../src/trigger/plugin';
import { InMemorySyntheticEventSource, createSyntheticTriggerProvider } from '../../../src/trigger/providers';
import { createFakeTriggerProvider, fakeTriggerInstance } from '../../fixtures/trigger/fake-trigger-provider';

describe('runTriggerProviderContract', () => {
  it('exercises ingress, health, drain and idempotent close', async () => {
    const close = vi.fn(async () => undefined);
    const result = await runTriggerProviderContract({ provider: createFakeTriggerProvider({ emitOnStart: true, close }), instance: fakeTriggerInstance() });
    expect(result.accepted).toHaveLength(1);
    expect(result.initialSnapshot.state).toBe('ready');
    expect(result.health.status).toBe('healthy');
    expect(result.drain.drained).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('can stimulate a real push provider after its runtime is ready', async () => {
    const source = new InMemorySyntheticEventSource();
    const result = await runTriggerProviderContract({
      provider: createSyntheticTriggerProvider(source),
      instance: {
        profileId: 'contract-profile', providerId: 'synthetic-event', instanceId: 'primary',
        enabled: true, configVersion: 1,
        config: { definitionId: 'definition-1', scopeRef: 'scope-1', actorRef: 'contract-source' },
        secretRefs: {},
      },
      exercise: async () => {
        await source.publish({ id: 'push-event-1', occurredAt: 1, data: { harmless: true } });
      },
    });
    expect(result.accepted).toEqual([
      expect.objectContaining({ sourceKind: 'internal-event', sourceEventId: 'push-event-1' }),
    ]);
  });
});
