import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelManager } from '../../../src/channel/manager';
import { ChannelPluginRegistry } from '../../../src/channel/plugin/registry';
import {
  FileTriggerResultDeliveryStore,
  InMemoryTriggerResultDeliveryStore,
  TriggerResultRouter,
} from '../../../src/trigger/result';
import {
  TRIGGER_STATE_SCHEMA_VERSION,
  type TriggerDefinition,
  type TriggerOccurrence,
} from '../../../src/trigger/state';
import {
  createFakeChannelPlugin,
  fakeChannelInstance,
} from '../../fixtures/channel/fake-channel-plugin';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('TriggerResultRouter', () => {
  it('routes proactively through a non-Lark channel plugin with a deterministic delivery id', async () => {
    const deliver = vi.fn(async (intent) => ({
      deliveryId: intent.deliveryId,
      status: 'sent' as const,
      providerMessageId: `fake:${intent.deliveryId}`,
      deliveredAt: 101,
    }));
    const registry = new ChannelPluginRegistry();
    registry.register(createFakeChannelPlugin({ proactiveMessages: true, deliver }));
    const manager = new ChannelManager({ profileId: 'profile-a', registry });
    await manager.start([{
      instance: fakeChannelInstance({ profileId: 'profile-a' }),
      ingress: { accept: async () => ({ status: 'accepted', receiptId: 'ignored' }) },
    }]);
    const store = new InMemoryTriggerResultDeliveryStore();
    const router = new TriggerResultRouter({
      store,
      resolver: {
        resolve: async () => ({
          profileId: 'profile-a', pluginId: 'fake-channel', instanceId: 'primary', scopeId: 'scope-a',
          sourceMessageId: 'message-a',
        }),
      },
      channel: manager,
      now: () => 100,
    });

    await router.route(definition(), occurrence(), { status: 'succeeded', output: { text: 'report ready' } });
    await router.route(definition(), occurrence(), { status: 'succeeded', output: { text: 'report ready' } });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'occurrence-a:conversation',
      scopeId: 'scope-a',
      sourceMessageId: 'message-a',
      content: { kind: 'text', text: 'report ready' },
    }));
    expect(await store.get('occurrence-a:conversation')).toMatchObject({
      state: 'sent', attempt: 1,
      receipt: { providerMessageId: 'fake:occurrence-a:conversation' },
    });
    await manager.close();
  });

  it('persists a failed delivery and resumes it after process restart without rerunning the agent', async () => {
    let now = 1_000;
    const directory = await mkdtemp(join(tmpdir(), 'aria-trigger-results-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'deliveries.json');
    const firstDeliver = vi.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'provider-offline' });
    });
    const first = routerWith(new FileTriggerResultDeliveryStore(path), firstDeliver, () => now);

    await first.route(definition(), occurrence(), { status: 'succeeded', output: { text: 'done' } });
    expect(await new FileTriggerResultDeliveryStore(path).get('occurrence-a:conversation')).toMatchObject({
      state: 'retry-wait', attempt: 1, errorCode: 'provider-offline', nextAttemptAt: 1_010,
    });

    now = 1_010;
    const secondDeliver = vi.fn(async (intent) => ({
      deliveryId: intent.deliveryId, status: 'sent' as const, deliveredAt: now,
    }));
    const restarted = routerWith(new FileTriggerResultDeliveryStore(path), secondDeliver, () => now);
    await restarted.reconcile();

    expect(firstDeliver).toHaveBeenCalledTimes(1);
    expect(secondDeliver).toHaveBeenCalledTimes(1);
    expect(await new FileTriggerResultDeliveryStore(path).get('occurrence-a:conversation')).toMatchObject({
      state: 'sent', attempt: 2,
    });
  });
});

function routerWith(
  store: FileTriggerResultDeliveryStore,
  deliver: (intent: Parameters<ChannelManager['deliver']>[0]) => ReturnType<ChannelManager['deliver']>,
  now: () => number,
) {
  return new TriggerResultRouter({
    store,
    resolver: {
      resolve: async () => ({
        profileId: 'profile-a', pluginId: 'fake-channel', instanceId: 'primary', scopeId: 'scope-a',
      }),
    },
    channel: { deliver },
    now,
    retryDelayMs: 10,
  });
}

function definition(): TriggerDefinition {
  return {
    schemaVersion: TRIGGER_STATE_SCHEMA_VERSION,
    id: 'definition-a', profileId: 'profile-a', providerId: 'schedule', instanceId: 'clock',
    sourceKind: 'schedule', state: 'active', revision: 1,
    ownerRef: 'user-a', createdBy: { kind: 'user', actorRef: 'user-a' },
    authorizationGrantRef: 'grant-a',
    authorizationCeiling: {
      maxRuntimeMs: 60_000, maxAttemptsPerOccurrence: 3, allowWakeProfile: false,
      allowedResultRouteIds: ['conversation'],
    },
    triggerSpec: {},
    intentTemplate: {
      actor: { kind: 'system', actorRef: 'schedule' }, authorizationRef: 'grant-a', scopeRef: 'scope-a',
      sessionPolicy: { kind: 'fresh' }, input: { prompt: 'work', attachments: [] },
      workspaceRef: { kind: 'profile-default' }, engineRequirements: { inputs: ['text'], capabilities: [] },
      resultRoutes: [{ kind: 'conversation', routeId: 'conversation', conversationRef: 'opaque-ref' }],
    },
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0 },
    quota: { maxActiveOccurrences: 1, maxRunsPerDay: 24 },
    misfirePolicy: 'coalesce', overlapPolicy: { kind: 'queue-one' },
    createdAt: 1, updatedAt: 1, metadata: {},
  };
}

function occurrence(): TriggerOccurrence {
  return {
    schemaVersion: TRIGGER_STATE_SCHEMA_VERSION,
    id: 'occurrence-a', idempotencyKey: 'definition-a:1:100', profileId: 'profile-a',
    definitionId: 'definition-a', definitionRevision: 1, scheduledFor: 100,
    state: 'succeeded', attempt: 1, fence: 1, createdAt: 1, updatedAt: 100,
    completedAt: 100, metadata: {},
  };
}
