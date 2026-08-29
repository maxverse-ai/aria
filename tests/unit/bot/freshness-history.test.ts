import type { LarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { ChatTopologyResolver } from '../../../src/bot/chat-topology.js';
import { fetchFreshnessHistory } from '../../../src/bot/freshness-history.js';

describe('fetchFreshnessHistory', () => {
  it('queries only the current topic and preserves structured addressing', async () => {
    const list = vi.fn(async () => ({
      data: {
        items: [item('om_late', {
          mentions: [{
            key: '@_user_1',
            id: { open_id: 'ou_self' },
            name: 'Self',
          }],
        })],
        has_more: false,
      },
    }));
    const { channel, topology } = harness(list, 2, 1);

    const result = await fetchFreshnessHistory({
      channel,
      chatTopology: topology,
      chatId: 'oc_group',
      chatType: 'group',
      threadId: 'th_current',
      afterMs: 1_760_000_000_000,
      knownInputIds: new Set(),
    });

    expect(result.status).toBe('complete');
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]?.addressing).toEqual({
      addressedToAgent: true,
      kind: 'structured-mention',
    });
    expect(result.inputs[0]?.senderType).toBe('user');
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        container_id_type: 'thread',
        container_id: 'th_current',
      }),
    }));
  });

  it('reuses exclusive-group topology for an unmentioned remote message', async () => {
    const list = vi.fn(async () => ({
      data: { items: [item('om_unmentioned')], has_more: false },
    }));
    const { channel, topology } = harness(list, 1, 1);

    const result = await fetchFreshnessHistory({
      channel,
      chatTopology: topology,
      chatId: 'oc_group',
      chatType: 'group',
      afterMs: 1_760_000_000_000,
      knownInputIds: new Set(),
    });

    expect(result.inputs[0]?.addressing).toEqual({
      addressedToAgent: true,
      kind: 'exclusive-group',
    });
  });

  it('keeps an unmentioned multi-person group message ambient', async () => {
    const list = vi.fn(async () => ({
      data: { items: [item('om_ambient')], has_more: false },
    }));
    const { channel, topology } = harness(list, 2, 1);

    const result = await fetchFreshnessHistory({
      channel,
      chatTopology: topology,
      chatId: 'oc_group',
      chatType: 'group',
      afterMs: 1_760_000_000_000,
      knownInputIds: new Set(),
    });

    expect(result.inputs[0]?.addressing).toEqual({
      addressedToAgent: false,
      kind: 'ambient-group',
    });
  });

  it('does not require group topology to retain bot output for duplicate checks', async () => {
    const list = vi.fn(async () => ({
      data: { items: [item('om_bot', { senderType: 'app' })], has_more: false },
    }));
    const { channel, topology } = harness(list, 2, 1);
    vi.mocked(channel.getChatMembers).mockRejectedValue(new Error('roster unavailable'));

    const result = await fetchFreshnessHistory({
      channel,
      chatTopology: topology,
      chatId: 'oc_group',
      chatType: 'group',
      afterMs: 1_760_000_000_000,
      knownInputIds: new Set(),
    });

    expect(result.status).toBe('complete');
    expect(result.inputs[0]?.senderType).toBe('bot');
    expect(channel.getChatMembers).not.toHaveBeenCalled();
  });

  it('retains an item with a missing timestamp but does not claim a complete snapshot', async () => {
    const list = vi.fn(async () => ({
      data: { items: [item('om_unknown_time', { createTime: undefined })], has_more: false },
    }));
    const { channel, topology } = harness(list, 1, 1);

    const result = await fetchFreshnessHistory({
      channel,
      chatTopology: topology,
      chatId: 'oc_dm',
      chatType: 'p2p',
      afterMs: 1_760_000_000_000,
      knownInputIds: new Set(),
    });

    expect(result.status).toBe('unavailable');
    expect(result.inputs.map((entry) => entry.message.messageId)).toEqual(['om_unknown_time']);
  });

  it('reports truncation instead of claiming a complete snapshot', async () => {
    const list = vi.fn(async () => ({
      data: {
        items: [item('om_first')],
        has_more: true,
        page_token: 'next',
      },
    }));
    const { channel, topology } = harness(list, 1, 1);

    const result = await fetchFreshnessHistory({
      channel,
      chatTopology: topology,
      chatId: 'oc_dm',
      chatType: 'p2p',
      afterMs: 1_760_000_000_000,
      knownInputIds: new Set(),
      maxMessages: 1,
    });

    expect(result.status).toBe('truncated');
  });
});

function harness(
  list: ReturnType<typeof vi.fn>,
  humanCount: number,
  botCount: number,
): { channel: LarkChannel; topology: ChatTopologyResolver } {
  const channel = {
    botIdentity: { openId: 'ou_self', name: 'Self' },
    rawClient: { im: { v1: { message: { list } } } },
    getChatMembers: vi.fn(async () =>
      Array.from({ length: humanCount }, (_, index) => ({ id: `ou_human_${index}` }))),
    getChatBots: vi.fn(async () =>
      Array.from({ length: botCount }, (_, index) => ({
        id: `ou_bot_${index}`,
        isBot: true as const,
      }))),
  } as unknown as LarkChannel;
  return { channel, topology: new ChatTopologyResolver(channel) };
}

function item(
  messageId: string,
  overrides: {
    mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
    senderType?: 'user' | 'app';
    createTime?: string;
  } = {},
) {
  return {
    message_id: messageId,
    msg_type: 'text',
    body: { content: JSON.stringify({ text: 'late input' }) },
    sender: { id: 'ou_user', sender_type: overrides.senderType ?? 'user' },
    create_time: 'createTime' in overrides ? overrides.createTime : '1760000001000',
    mentions: overrides.mentions ?? [],
  };
}
