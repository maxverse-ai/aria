import { normalize, type LarkChannel, type NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import type { ChatTopologyResolver } from '../../../src/bot/chat-topology.js';
import type { ConversationInput } from '../../../src/bot/conversation-input.js';
import { FinalReplyFreshness } from '../../../src/bot/final-reply-freshness.js';
import type { FreshnessHistoryResult } from '../../../src/bot/freshness-history.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';

describe('FinalReplyFreshness', () => {
  it.each(['local', 'remote'])('keeps self-only ping freshness behavior for %s input', async source => {
    const message = await normalize({
      sender: { sender_id: { open_id: 'ou_human' }, sender_type: 'user' },
      message: { message_id: 'ping', chat_id: 'scope', chat_type: 'group', message_type: 'text',
        content: JSON.stringify({ text: '@_user_1' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bridge' }],
      },
    }, { botIdentity: { openId: 'ou_bot', name: 'Bridge' }, stripBotMentions: false, includeRaw: true });
    const ping = conversation('ping');
    ping.message = { ...message, createTime: 1_760_000_001_000 };
    const h = harness(async () => ({ status: 'complete', inputs: source === 'remote' ? [ping] : [] }));
    h.pending.block('scope');
    if (source === 'local') h.pending.push('scope', ping);
    await expect(h.freshness.inspect(request())).resolves.toEqual({ kind: 'fresh' });
    expect(message.content).toBe('@Bridge');
  });

  it('holds immediately on local addressed input and records next-turn handoff', async () => {
    const history = vi.fn(async (): Promise<FreshnessHistoryResult> => ({
      status: 'complete',
      inputs: [],
    }));
    const h = harness(history);
    h.pending.block('scope');
    h.pending.push('scope', conversation('late', { resources: [{ type: 'file', fileKey: 'f' }] }));

    await expect(h.freshness.inspect(request())).resolves.toMatchObject({
      kind: 'hold',
      source: 'local',
      messageIds: ['late'],
    });
    expect(history).not.toHaveBeenCalled();
    expect(h.freshness.handoff('scope')).toEqual({
      previousDraftDelivery: 'withheld',
      reason: 'unseen-addressed-input',
      previousRunId: 'run-1',
    });
  });

  it('acknowledges the same handoff after deferred recall updates its delivery state', async () => {
    const h = harness(async () => ({ status: 'complete', inputs: [] }));
    h.pending.block('scope');
    h.pending.push('scope', conversation('late'));
    await h.freshness.inspect(request());
    const captured = h.freshness.handoff('scope');
    if (!captured) throw new Error('expected handoff');

    h.freshness.markHandoffDelivery('scope', 'run-1', 'retracted');
    h.freshness.acknowledgeHandoff('scope', captured);

    expect(h.freshness.handoff('scope')).toBeUndefined();
  });

  it('ignores a locally queued id already acknowledged by steering', async () => {
    const h = harness(async () => ({ status: 'complete', inputs: [] }));
    h.pending.block('scope');
    h.pending.push('scope', conversation('accepted'));

    await expect(h.freshness.inspect(request({ knownInputIds: new Set(['accepted']) })))
      .resolves.toEqual({ kind: 'fresh' });
  });

  it('gives a remote addressed message next-turn ownership before holding', async () => {
    const h = harness(async () => ({
      status: 'complete',
      inputs: [conversation('remote-late')],
    }));
    h.pending.block('scope');

    await expect(h.freshness.inspect(request())).resolves.toMatchObject({
      kind: 'hold',
      source: 'remote',
      messageIds: ['remote-late'],
    });
    expect(h.pending.snapshot('scope').map((entry) => entry.message.messageId))
      .toEqual(['remote-late']);
  });

  it.each(['unavailable', 'truncated'] as const)(
    'fails open when remote history is %s and no definite hold exists',
    async (status) => {
      const h = harness(async () => ({ status, inputs: [] }));
      await expect(h.freshness.inspect(request())).resolves.toEqual({
        kind: 'fail-open',
        reason: status === 'truncated' ? 'history-truncated' : 'history-unavailable',
      });
    },
  );

  it('fails open when the history backstop exceeds its latency budget', async () => {
    const h = harness(
      async () => new Promise<FreshnessHistoryResult>(() => {}),
      5,
    );

    await expect(h.freshness.inspect(request())).resolves.toEqual({
      kind: 'fail-open',
      reason: 'history-unavailable',
    });
  });

  it('withholds cooperative output on unavailable history', async () => {
    const h = harness(async () => ({ status: 'unavailable', inputs: [] }));
    await expect(h.freshness.inspect({ ...request(), requireCompleteHistory: true }))
      .resolves.toEqual({ kind: 'withheld', reason: 'history-unavailable' });
  });

  it('admits a remote peer only after both explicit addressing and access checks', async () => {
    const peer = conversation('peer', { senderType: 'bot', senderId: 'ou_peer' });
    peer.addressing = { addressedToAgent: true, kind: 'structured-mention' };
    const h = harness(async () => ({ status: 'complete', inputs: [peer] }));
    h.pending.block('scope');
    await expect(h.freshness.inspect({ ...request(), canAcceptRemote: () => false })).resolves.toEqual({ kind: 'fresh' });
    expect(h.pending.snapshot('scope')).toEqual([]);
    await expect(h.freshness.inspect(request())).resolves.toMatchObject({ kind: 'hold', messageIds: ['peer'] });
    expect(h.pending.snapshot('scope').map(e => e.message.messageId)).toEqual(['peer']);
  });

  it('uses bot output only for exact duplicate suppression', async () => {
    const h = harness(async () => ({
      status: 'complete',
      inputs: [conversation('bot-output', {
        senderId: 'ou_other_bot',
        senderType: 'bot',
        content: 'draft answer',
      })],
    }));

    await expect(h.freshness.inspect(request())).resolves.toMatchObject({
      kind: 'duplicate',
      source: 'remote',
      messageId: 'bot-output',
    });
    expect(h.pending.snapshot('scope')).toEqual([]);
  });
});

function harness(
  fetchHistory: (input: never) => Promise<FreshnessHistoryResult>,
  historyTimeoutMs?: number,
): { pending: PendingQueue; freshness: FinalReplyFreshness } {
  const pending = new PendingQueue(60_000, () => {});
  const channel = { botIdentity: { openId: 'ou_self', name: 'Self' } } as LarkChannel;
  const freshness = new FinalReplyFreshness({
    channel,
    chatTopology: {} as ChatTopologyResolver,
    pending,
    fetchHistory: fetchHistory as never,
    ...(historyTimeoutMs !== undefined ? { historyTimeoutMs } : {}),
  });
  return { pending, freshness };
}

function request(overrides: { knownInputIds?: ReadonlySet<string> } = {}) {
  return {
    scope: 'scope',
    turn: {
      scopeId: 'scope',
      runId: 'run-1',
      initialWatermarkMs: 1_760_000_000_000,
      knownInputIds: overrides.knownInputIds ?? new Set(['initial']),
    },
    draftText: 'draft answer',
    chatId: 'oc_chat',
    chatType: 'p2p' as const,
    canAcceptRemote: () => true,
  };
}

function conversation(
  messageId: string,
  overrides: {
    senderId?: string;
    senderType?: 'user' | 'bot';
    content?: string;
    resources?: NormalizedMessage['resources'];
    addressedToAgent?: boolean;
  } = {},
): ConversationInput {
  const senderType = overrides.senderType ?? 'user';
  return {
    message: {
      messageId,
      chatId: 'oc_chat',
      chatType: 'p2p',
      senderId: overrides.senderId ?? 'ou_user',
      senderType,
      senderIsBot: senderType === 'bot',
      content: overrides.content ?? 'new direction',
      rawContentType: 'text',
      resources: overrides.resources ?? [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 1_760_000_001_000,
    },
    addressing: {
      addressedToAgent: overrides.addressedToAgent ?? true,
      kind: 'direct-message',
    },
    senderType,
  };
}
