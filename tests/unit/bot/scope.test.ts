import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { ChatModeCache } from '../../../src/bot/chat-mode-cache';
import { resolveMessageConversation } from '../../../src/bot/scope';

describe('resolveMessageConversation', () => {
  it('uses one chat-level key for a regular group', async () => {
    const channel = channelWithMode('group');
    const message = normalizedMessage();

    await expect(resolveMessageConversation(channel, message, new ChatModeCache())).resolves.toMatchObject({
      message,
      key: 'oc_chat',
      kind: 'group',
      mode: 'group',
      resolvedMode: 'group',
      threadIdBackfilled: false,
      modeOverridden: false,
    });
  });

  it('backfills an omitted topic thread before producing the key', async () => {
    const channel = {
      getChatMode: vi.fn(async () => 'topic' as const),
      fetchRawMessage: vi.fn(async () => [{ thread_id: 'omt_topic' }]),
    } as unknown as LarkChannel;

    const resolved = await resolveMessageConversation(
      channel,
      normalizedMessage(),
      new ChatModeCache(),
    );

    expect(resolved).toMatchObject({
      key: 'oc_chat:omt_topic',
      kind: 'topic',
      mode: 'topic',
      resolvedMode: 'topic',
      threadId: 'omt_topic',
      threadIdBackfilled: true,
      modeOverridden: false,
    });
    expect(resolved.message.threadId).toBe('omt_topic');
  });

  it('treats a message thread as authoritative over a stale group mode', async () => {
    const channel = channelWithMode('group');
    const cache = new ChatModeCache();

    const resolved = await resolveMessageConversation(
      channel,
      normalizedMessage({ threadId: 'omt_converted' }),
      cache,
    );

    expect(resolved).toMatchObject({
      key: 'oc_chat:omt_converted',
      kind: 'topic',
      mode: 'topic',
      resolvedMode: 'group',
      modeOverridden: true,
    });
    await resolveMessageConversation(channel, normalizedMessage(), cache);
    expect(channel.getChatMode).toHaveBeenCalledTimes(2);
  });
});

function channelWithMode(mode: 'p2p' | 'group' | 'topic'): LarkChannel {
  return { getChatMode: vi.fn(async () => mode) } as unknown as LarkChannel;
}

function normalizedMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_message',
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: 'ou_sender',
    content: 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1,
    ...overrides,
  };
}
