import { describe, expect, it, vi } from 'vitest';
import { ChatTopologyResolver, isDmLikeTopology } from '../../../src/bot/chat-topology.js';

describe('ChatTopologyResolver', () => {
  it('recognizes exactly one human and one bot as DM-like', async () => {
    const client = fakeRosterClient(1, 1);
    const resolver = new ChatTopologyResolver(client as never);

    const topology = await resolver.resolve('oc_solo');

    expect(topology).toEqual({ humanCount: 1, botCount: 1 });
    expect(isDmLikeTopology(topology)).toBe(true);
    expect(client.getChatMembers).toHaveBeenCalledWith('oc_solo', { force: true });
    expect(client.getChatBots).toHaveBeenCalledWith('oc_solo', { force: true });
  });

  it.each([
    [2, 1],
    [1, 2],
    [1, 0],
  ])('does not classify %i humans and %i bots as DM-like', async (humans, bots) => {
    const resolver = new ChatTopologyResolver(fakeRosterClient(humans, bots) as never);
    expect(isDmLikeTopology(await resolver.resolve('oc_group'))).toBe(false);
  });

  it('coalesces concurrent refreshes and serves a cached result', async () => {
    const client = fakeRosterClient(1, 1);
    const resolver = new ChatTopologyResolver(client as never);

    await Promise.all([resolver.resolve('oc_solo'), resolver.resolve('oc_solo')]);
    await resolver.resolve('oc_solo');

    expect(client.getChatMembers).toHaveBeenCalledTimes(1);
    expect(client.getChatBots).toHaveBeenCalledTimes(1);
  });

  it('refreshes after the safety-sensitive DM-like TTL expires', async () => {
    let now = 1_000;
    const client = fakeRosterClient(1, 1);
    const resolver = new ChatTopologyResolver(client as never, {
      dmLikeTtlMs: 10,
      now: () => now,
    });

    await resolver.resolve('oc_solo');
    now += 11;
    await resolver.resolve('oc_solo');

    expect(client.getChatMembers).toHaveBeenCalledTimes(2);
    expect(client.getChatBots).toHaveBeenCalledTimes(2);
  });

  it('does not cache lookup failures', async () => {
    const client = fakeRosterClient(1, 1);
    client.getChatMembers.mockRejectedValueOnce(new Error('permission denied'));
    const resolver = new ChatTopologyResolver(client as never);

    await expect(resolver.resolve('oc_solo')).rejects.toThrow('permission denied');
    await expect(resolver.resolve('oc_solo')).resolves.toEqual({ humanCount: 1, botCount: 1 });
    expect(client.getChatMembers).toHaveBeenCalledTimes(2);
  });
});

function fakeRosterClient(humanCount: number, botCount: number) {
  return {
    getChatMembers: vi.fn(async () =>
      Array.from({ length: humanCount }, (_, i) => ({ id: `ou_${i}` })),
    ),
    getChatBots: vi.fn(async () =>
      Array.from({ length: botCount }, (_, i) => ({ id: `bot_${i}`, isBot: true })),
    ),
  };
}
