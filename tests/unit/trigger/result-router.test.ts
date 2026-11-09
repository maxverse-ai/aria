import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateFixture, directRequest } from '../../helpers/space-gate';
import { SpaceOperationLedger } from '../../../src/space/operation-ledger';
import { SpaceTriggerBoundary } from '../../../src/space/trigger-boundary';
import { createTriggerRunIntent } from '../../../src/trigger/runtime/intent';
import { ChannelManager } from '../../../src/channel/manager';
import { ChannelPluginRegistry } from '../../../src/channel/plugin/registry';
import {
  FileTriggerResultDeliveryStore,
  InMemoryTriggerResultDeliveryStore,
  TriggerResultRouter,
  TriggerResultRejectedError,
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
  it('quarantines pre-upgrade retry records lacking nonacceptance evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aria-result-legacy-')); temporaryDirectories.push(directory);
    const store = new FileTriggerResultDeliveryStore(join(directory, 'results.json'));
    await store.create({ schemaVersion: 1, deliveryId: 'legacy', occurrenceId: 'old', routeId: 'route',
      state: 'retry-wait', attempt: 1, createdAt: 1, updatedAt: 2, nextAttemptAt: 3,
      intent: { abiVersion: 1, deliveryId: 'legacy', profileId: 'p', pluginId: 'fake', instanceId: 'one',
        scopeId: 's', content: { kind: 'text', text: 'old result' } } });
    expect(await store.listReady(1000)).toEqual([]);
    const [unknown] = await store.listUncertain();
    expect(unknown).toMatchObject({ state: 'uncertain', errorCode: 'legacy-result-outcome-unknown' });
    expect(await store.settle({ ...unknown!, state: 'failed' }, unknown!.claimToken!)).toBe(true);
  });
  it('retains unknown accepted delivery across reconcile and operator resolution never resends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aria-result-unknown-')); temporaryDirectories.push(directory);
    const store = new FileTriggerResultDeliveryStore(join(directory, 'results.json'));
    const deliver = vi.fn(async () => { throw new Error('timeout after acceptance'); });
    const router = routerWith(store, deliver, () => 1000);
    await router.route(definition(), occurrence(), { status: 'succeeded', output: { text: 'done' } });
    await router.reconcile();
    const [unknown] = await router.inspectUncertain();
    if (!unknown) throw new Error('expected uncertain delivery');
    expect(unknown).toMatchObject({ state: 'uncertain', attempt: 1 });
    expect(deliver).toHaveBeenCalledOnce();
    expect(await router.resolveUncertain(unknown.deliveryId, 'wrong-owner', { abandon: true, reason: 'checked' })).toBe(false);
    expect(await router.resolveUncertain(unknown.deliveryId, unknown.claimToken!, { reason: 'provider confirms delivery',
      receipt: { deliveryId: unknown.deliveryId, status: 'sent', deliveredAt: 1000 } })).toBe(true);
    expect(await store.settle({ ...unknown, state: 'failed' }, unknown.claimToken!)).toBe(false);
    await router.reconcile();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('receipt checkpoint failure keeps durable delivering claim without retrying provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aria-result-checkpoint-')); temporaryDirectories.push(directory);
    const store = new FileTriggerResultDeliveryStore(join(directory, 'results.json'));
    const deliver = vi.fn(async intent => ({ deliveryId: intent.deliveryId, status: 'sent' as const, deliveredAt: 1000 }));
    const router = routerWith(store, deliver, () => 1000);
    vi.spyOn(store, 'settle').mockRejectedValueOnce(new Error('disk checkpoint failed'));
    await expect(router.route(definition(), occurrence(), { status: 'succeeded', output: { text: 'done' } })).rejects.toThrow('disk checkpoint');
    await router.reconcile();
    expect(deliver).toHaveBeenCalledOnce();
    expect((await store.listUncertain())[0]).toMatchObject({ state: 'delivering', attempt: 1 });
  });

  it('X3/X4: recovered team results retain the original principal, definition revision and destination epoch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aria-trigger-space-')); temporaryDirectories.push(directory);
    const f = await gateFixture(directory, { persistent: true });
    const ledgerFile = join(directory, 'operations.json');
    const ledger = new SpaceOperationLedger(f.gate, ledgerFile); await ledger.load();
    const boundary = new SpaceTriggerBoundary(ledger, { pluginId: 'fixture', instanceId: 'primary' });
    const d = definition(); d.profileId = 'profile'; d.intentTemplate.actor = { kind: 'user', actorRef: 'a' }; d.intentTemplate.scopeRef = 'group';
    const o = occurrence(); o.profileId = 'profile';
    const operation = await f.gate.enter({ ...directRequest('a', 'group'), kind: 'group' }, 'group');
    await boundary.bindDefinition(d, operation);
    const intent = createTriggerRunIntent(d, o, 'intent');
    expect((await boundary.authorizeIntent(intent)).bindingRef).toBe(operation.bindingRef);
    await expect(boundary.authorizeIntent({ ...intent, actor: { kind: 'user', actorRef: 'b' } })).rejects.toThrow('matching original');
    const storeFile = join(directory, 'results.json');
    const send = vi.fn(async () => { throw new Error('offline'); });
    const router = new TriggerResultRouter({ store: new FileTriggerResultDeliveryStore(storeFile),
      resolver: { resolve: async () => ({ profileId: 'profile', pluginId: 'fixture', instanceId: 'primary', scopeId: 'group' }) },
      beforeCheckpoint: (definition, output) => boundary.bindResult(definition, output),
      channel: { deliver: output => boundary.deliver(output, send) }, now: () => f.state.now, retryDelayMs: 10 });
    await router.route(d, o, { status: 'succeeded', output: { text: 'private answer' } });
    expect(send).toHaveBeenCalledOnce();
    await f.services.close();
    const restored = await gateFixture(directory, { persistent: true });
    try {
      restored.state.humans = ['a', 'b']; restored.state.now += 10;
      const saved = new SpaceOperationLedger(restored.gate, ledgerFile); await saved.load();
      const recoveredBoundary = new SpaceTriggerBoundary(saved, { pluginId: 'fixture', instanceId: 'primary' });
      const retrySend = vi.fn(async output => ({ deliveryId: output.deliveryId, status: 'sent' as const, deliveredAt: 1010 }));
      const recovered = new TriggerResultRouter({ store: new FileTriggerResultDeliveryStore(storeFile),
        resolver: { resolve: async () => { throw new Error('retry must use the saved destination'); } },
        channel: { deliver: output => recoveredBoundary.deliver(output, () => retrySend(output)) }, now: () => restored.state.now, retryDelayMs: 10 });
      await recovered.reconcile();
      expect(retrySend).not.toHaveBeenCalled();
      expect(await new FileTriggerResultDeliveryStore(storeFile).get('occurrence-a:conversation')).toMatchObject({ state: 'uncertain', attempt: 1 });
    } finally { await restored.services.close(); }
  });

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
      throw new TriggerResultRejectedError('provider-offline');
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
