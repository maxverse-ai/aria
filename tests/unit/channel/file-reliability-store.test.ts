import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
import { CHANNEL_PLUGIN_ABI_VERSION, type ChannelInboundEnvelope } from '../../../src/channel/plugin/types';
import { ChannelReliabilityCoordinator } from '../../../src/channel/reliability/coordinator';
import { FileChannelReliabilityStores } from '../../../src/channel/reliability/file-store';
import { reliabilityKeyFromEnvelope } from '../../../src/channel/reliability/key';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aria-channel-reliability-'));
  roots.push(root);
  return join(root, 'state.json');
}

function envelope(sourceMessageId = 'source-1'): ChannelInboundEnvelope {
  return {
    abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
    profileId: 'profile-a',
    pluginId: 'wechat-kf',
    instanceId: 'customer-service',
    sourceMessageId,
    scopeId: 'scope-a',
    actorId: 'actor-a',
    conversation: 'p2p',
    occurredAt: 1,
    content: { kind: 'text', text: 'hello' },
  };
}

describe('FileChannelReliabilityStores', () => {
  it('persists first-write-wins records across independent store instances', async () => {
    const path = await statePath();
    const left = new FileChannelReliabilityStores(path);
    const right = new FileChannelReliabilityStores(path);
    const input = envelope();
    const key = reliabilityKeyFromEnvelope(input);
    const record = { key, envelope: input, receiptId: 'receipt-1', acceptedAt: 10 };

    const accepted = await Promise.all([left.inbox.accept(record), right.inbox.accept(record)]);
    expect(accepted.map((entry) => entry.status).sort()).toEqual(['accepted', 'duplicate']);

    const first = await left.answers.create({ key, createdAt: 11, intents: [] });
    const second = await right.answers.create({ key, createdAt: 12, intents: [] });
    expect(first.createdAt).toBe(11);
    expect(second.createdAt).toBe(11);
    expect(await new FileChannelReliabilityStores(path).inbox.list()).toHaveLength(1);
    expect((await readFile(path, 'utf8')).match(/profile-a/g)?.length).toBeGreaterThan(0);
  });

  it('fences lease release and lets an expired worker be reclaimed', async () => {
    const stores = new FileChannelReliabilityStores(await statePath());
    const input = envelope();
    const key = reliabilityKeyFromEnvelope(input);
    await stores.inbox.accept({ key, envelope: input, receiptId: 'receipt-1', acceptedAt: 1 });

    expect(await stores.inbox.claim(key, 10, 20, 'worker-a')).toMatchObject({ leaseId: 'worker-a' });
    expect(await stores.inbox.claim(key, 15, 25, 'worker-b')).toBeUndefined();
    expect(await stores.inbox.claim(key, 20, 30, 'worker-b')).toMatchObject({ leaseId: 'worker-b' });
    await stores.inbox.release(key, 'worker-a');
    expect(await stores.inbox.get(key)).toMatchObject({ leaseId: 'worker-b' });
    await stores.inbox.release(key, 'worker-b');
    expect(await stores.inbox.get(key)).not.toHaveProperty('leaseId');
  });

  it('resumes a partial delivery after process restart without rerunning the answer', async () => {
    const path = await statePath();
    const input = envelope();
    const key = reliabilityKeyFromEnvelope(input);
    const process = vi.fn(async () => [
      { ...input, deliveryId: 'part-1', content: { kind: 'text' as const, text: 'one' } },
      { ...input, deliveryId: 'part-2', content: { kind: 'text' as const, text: 'two' } },
    ]);
    let now = 100;
    const firstDeliver = vi.fn(async (intent: { deliveryId: string }) => {
      if (intent.deliveryId === 'part-2') {
        throw new ChannelPluginError('temporary', { kind: 'transient', code: 'provider-busy' });
      }
      return { deliveryId: intent.deliveryId, status: 'sent' as const, deliveredAt: now };
    });
    const first = new ChannelReliabilityCoordinator({
      stores: new FileChannelReliabilityStores(path),
      processor: { process },
      deliverer: { deliver: firstDeliver },
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      now: () => now,
    });
    await first.accept(input);
    await expect(first.run(key)).resolves.toMatchObject({ status: 'waiting' });

    now = 101;
    const secondDeliver = vi.fn(async (intent: { deliveryId: string }) => ({
      deliveryId: intent.deliveryId,
      status: 'sent' as const,
      deliveredAt: now,
    }));
    const restarted = new ChannelReliabilityCoordinator({
      stores: new FileChannelReliabilityStores(path),
      processor: { process },
      deliverer: { deliver: secondDeliver },
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      now: () => now,
    });
    await expect(restarted.run(key)).resolves.toMatchObject({ status: 'completed' });
    expect(process).toHaveBeenCalledOnce();
    expect(secondDeliver).toHaveBeenCalledOnce();
    expect(secondDeliver.mock.calls[0]?.[0]).toMatchObject({ deliveryId: 'part-2' });
  });

  it('rejects a corrupted snapshot instead of silently discarding durable work', async () => {
    const path = await statePath();
    await writeFile(path, '{"schema":"wrong"}\n', { mode: 0o600 });
    await expect(new FileChannelReliabilityStores(path).inbox.list())
      .rejects.toThrow('invalid channel reliability state file');
  });
});
