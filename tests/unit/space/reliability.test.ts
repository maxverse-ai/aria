import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { gateFixture, directRequest } from '../../helpers/space-gate';
import { SpaceOperationLedger } from '../../../src/space/operation-ledger';
import { BoundChannelReliability } from '../../../src/channel/reliability/space-boundary';
import { ChannelReliabilityCoordinator } from '../../../src/channel/reliability/coordinator';
import { InMemoryChannelReliabilityStores } from '../../../src/channel/reliability/memory-store';
import { reliabilityKeyFromEnvelope } from '../../../src/channel/reliability/key';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
import { CHANNEL_PLUGIN_ABI_VERSION, type ChannelInboundEnvelope } from '../../../src/channel/plugin/types';

it('X1/X4: the real inbox/answer coordinator retries delivery under the original epoch without running a completed agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-space-reliability-')); const f = await gateFixture(root);
  try {
    const envelope: ChannelInboundEnvelope = { abiVersion: CHANNEL_PLUGIN_ABI_VERSION, profileId: 'profile', pluginId: 'fixture', instanceId: 'primary',
      sourceMessageId: 'message', scopeId: 'group', actorId: 'a', conversation: 'group', occurredAt: 1, content: { kind: 'text', text: 'private work' } };
    const { actorId: _, conversation: __, occurredAt: ___, ...common } = envelope;
    const answer = { ...common, deliveryId: 'answer', content: { kind: 'text' as const, text: 'private result' } };
    const stores = new InMemoryChannelReliabilityStores(); const process = vi.fn(async () => [answer]);
    const deliver = vi.fn(async () => { throw new ChannelPluginError('offline', { kind: 'transient', code: 'offline' }); });
    const boundary = new BoundChannelReliability(new SpaceOperationLedger(f.gate), { profileId: 'profile', pluginId: 'fixture', instanceId: 'primary',
      identity: () => ({ ...directRequest('a', 'group'), kind: 'group' }) });
    const coordinator = new ChannelReliabilityCoordinator({ stores, spaceBoundary: boundary, processor: { process }, deliverer: { deliver },
      now: () => f.state.now, retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 } });
    await expect(coordinator.accept({ ...envelope, instanceId: 'foreign' })).rejects.toThrow('account');
    expect(await stores.inbox.list()).toEqual([]);
    await coordinator.accept(envelope);
    expect(await coordinator.run(reliabilityKeyFromEnvelope(envelope))).toMatchObject({ status: 'waiting' });
    expect(process).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
    f.state.now += 10; f.state.humans = ['a', 'b'];
    await coordinator.recover();
    expect(process).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
    expect(await stores.answers.get(reliabilityKeyFromEnvelope(envelope))).toBeDefined();
  } finally { await f.services.close(); await rm(root, { recursive: true, force: true }); }
});
