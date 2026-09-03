import {
  TRIGGER_PROVIDER_ABI_VERSION,
  type ResolvedTriggerInstance,
  type TriggerEnvelope,
  type TriggerProvider,
  type TriggerProviderConfig,
  type TriggerRuntime,
} from '../../../src/trigger/plugin';

export type FakeTriggerConfig = TriggerProviderConfig & { label: string };

export function fakeTriggerInstance(overrides: Partial<ResolvedTriggerInstance<FakeTriggerConfig>> = {}): ResolvedTriggerInstance<FakeTriggerConfig> {
  return {
    profileId: 'contract-profile', providerId: 'fake-trigger', instanceId: 'primary',
    enabled: true, configVersion: 1, config: { label: 'Clock' }, secretRefs: {}, ...overrides,
  };
}

export function fakeTriggerEnvelope(instance = fakeTriggerInstance()): TriggerEnvelope {
  return {
    abiVersion: TRIGGER_PROVIDER_ABI_VERSION,
    profileId: instance.profileId, providerId: instance.providerId, instanceId: instance.instanceId,
    sourceKind: 'schedule', sourceEventId: 'event-1', triggerDefinitionId: 'definition-1',
    occurredAt: 1, observedAt: 2, scopeRef: 'scope-1',
    actor: { kind: 'system', actorRef: 'scheduler' }, data: { scheduledFor: 1 },
  };
}

export function createFakeTriggerProvider(options: { emitOnStart?: boolean; close?: () => Promise<void> } = {}): TriggerProvider<FakeTriggerConfig> {
  return {
    manifest: {
      abiVersion: TRIGGER_PROVIDER_ABI_VERSION, id: 'fake-trigger', displayName: 'Fake Trigger',
      package: { name: '@maxverse-ai/aria-trigger-fake', version: '1.0.0' },
      configVersion: 1,
      configSchema: { type: 'object', required: ['label'], properties: { label: { type: 'string' } } },
      capabilities: { ingress: 'clock', sources: ['schedule'], replay: 'source-event-id', acknowledgements: true },
    },
    validateConfig(config: unknown): FakeTriggerConfig {
      if (typeof config !== 'object' || config === null || typeof (config as { label?: unknown }).label !== 'string') throw new Error('label is required');
      return { label: (config as { label: string }).label };
    },
    async start(context): Promise<TriggerRuntime> {
      if (options.emitOnStart) await context.ingress.accept(fakeTriggerEnvelope(context.instance));
      return {
        instance: { profileId: context.instance.profileId, providerId: context.instance.providerId, instanceId: context.instance.instanceId },
        snapshot: () => ({
          profileId: context.instance.profileId,
          providerId: context.instance.providerId,
          instanceId: context.instance.instanceId,
          state: 'ready', acceptingEvents: true, inFlightEvents: 0, updatedAt: 2,
        }),
        health: async () => ({ status: 'healthy', checkedAt: 2 }),
        drain: async () => ({ drained: true, remainingEvents: 0 }),
        close: options.close ?? (async () => undefined),
      };
    },
  };
}
