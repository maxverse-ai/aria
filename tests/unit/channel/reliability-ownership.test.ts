import { describe, expect, it, vi } from 'vitest';
import { ChannelReliabilityCoordinator } from '../../../src/channel/reliability/coordinator';
import { InMemoryChannelReliabilityStores } from '../../../src/channel/reliability/memory-store';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
import { reliabilityKeyFromEnvelope } from '../../../src/channel/reliability/key';

const input = { abiVersion: 1 as const, profileId: 'test', pluginId: 'test', instanceId: 'test', sourceMessageId: 'one',
  scopeId: 'test', actorId: 'test', conversation: 'p2p' as const, occurredAt: 0, content: { kind: 'text' as const, text: 'synthetic' } };
const key = reliabilityKeyFromEnvelope(input);
function coordinator(stores: InMemoryChannelReliabilityStores, process: () => Promise<readonly never[]>, now: () => number) {
  return new ChannelReliabilityCoordinator({ stores, processor: { process }, deliverer: { deliver: vi.fn() }, leaseMs: 30, now });
}

describe('guarded reliability ownership', () => {
  it('expired live processing cannot be taken over; the original owner can settle', async () => {
    let now = 0;
    const stores = new InMemoryChannelReliabilityStores();
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const process = vi.fn(async () => { entered(); await barrier; return [] as const; });
    const a = coordinator(stores, process, () => now), b = coordinator(stores, process, () => now);
    await a.accept(input);
    const running = a.run(key);
    await started;
    now = 100;
    await expect(b.run(key)).resolves.toMatchObject({ status: 'uncertain' });
    expect(process).toHaveBeenCalledOnce();
    finish();
    await expect(running).resolves.toMatchObject({ status: 'completed' });
    await expect(b.run(key)).resolves.toMatchObject({ status: 'completed' });
    expect(process).toHaveBeenCalledOnce();
  });

  it('generic and typed processor failures retain uncertainty until verified reconciliation', async () => {
    const stores = new InMemoryChannelReliabilityStores();
    let now = 0;
    const process = vi.fn(async () => { throw new ChannelPluginError('timeout after acceptance', { kind: 'transient', code: 'timeout' }); });
    const a = coordinator(stores, process, () => now);
    await a.accept(input);
    const result = await a.run(key);
    expect(result.status).toBe('uncertain');
    if (result.status !== 'uncertain') throw new Error('expected fence');
    now = 100;
    await expect(a.run(key)).resolves.toMatchObject({ status: 'uncertain' });
    await expect(a.reconcile(key, { leaseId: result.leaseId, ownerTerminated: true, outcome: 'checkpointed' })).resolves.toBe(false);
    await expect(a.reconcile(key, { leaseId: 'obsolete', ownerTerminated: true, outcome: 'not-accepted' })).resolves.toBe(false);
    await expect(a.reconcile(key, { leaseId: result.leaseId, ownerTerminated: true, outcome: 'not-accepted' })).resolves.toBe(true);
    const safe = coordinator(stores, async () => [], () => now);
    await expect(safe.run(key)).resolves.toMatchObject({ status: 'completed' });
    expect(process).toHaveBeenCalledOnce();
  });

  it('stale owners cannot mutate checkpoints, receipts, retry, or cleanup after idle takeover', async () => {
    const stores = new InMemoryChannelReliabilityStores();
    const a = coordinator(stores, async () => [], () => 0);
    await a.accept(input);
    await stores.inbox.claim(key, 0, 10, 'old');
    await stores.inbox.claim(key, 10, 20, 'new', true);
    const fence = { leaseId: 'old' };
    await expect(stores.answers.create({ key, createdAt: 10, intents: [] }, fence)).rejects.toThrow('ownership lost');
    await expect(stores.receipts.complete({ key, receiptId: 'test', completedAt: 10 }, fence)).rejects.toThrow('ownership lost');
    await expect(stores.inbox.remove(key, fence)).rejects.toThrow('ownership lost');
    await expect(stores.inbox.renew(key, 'old', 10, 30)).resolves.toBe(false);
    expect((await stores.inbox.get(key))?.leaseId).toBe('new');
  });
  it('renews live guards and stops heartbeat after completion', async () => {
    vi.useFakeTimers();
    try {
      const stores = new InMemoryChannelReliabilityStores();
      const renew = vi.spyOn(stores.inbox, 'renew');
      let entered!: () => void, finish!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const barrier = new Promise<void>(resolve => { finish = resolve; });
      const a = coordinator(stores, async () => { entered(); await barrier; return []; }, () => Date.now());
      await a.accept(input); const running = a.run(key); await started;
      await vi.advanceTimersByTimeAsync(20);
      expect(renew).toHaveBeenCalledTimes(2);
      finish(); await running;
      await vi.advanceTimersByTimeAsync(100);
      expect(renew).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('reconciles batch fences atomically and refuses a mixed-owner batch', async () => {
    const stores = new InMemoryChannelReliabilityStores();
    const otherInput = { ...input, sourceMessageId: 'two' };
    const other = reliabilityKeyFromEnvelope(otherInput);
    const a = coordinator(stores, async () => [], () => 0);
    await a.accept(input); await a.accept(otherInput);
    await stores.inbox.claim(key, 0, 10, 'batch', true);
    await stores.inbox.claim(other, 0, 10, 'different', true);
    await expect(stores.inbox.reconcile([key, other], 'batch', false)).resolves.toBe(false);
    expect((await stores.inbox.get(key))?.guarded).toBe(true);
    await stores.inbox.release(other, 'different');
    await stores.inbox.claim(other, 10, 20, 'batch', true);
    await stores.answers.create({ key, createdAt: 10, intents: [] }, { leaseId: 'batch' });
    await expect(stores.inbox.reconcile([key, other], 'batch', true)).resolves.toBe(true);
    expect((await stores.inbox.get(key))?.leaseId).toBeUndefined();
    expect((await stores.inbox.get(other))?.leaseId).toBeUndefined();
  });

});
