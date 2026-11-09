import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { tryMergeLiveFollowup } from '../../../src/bot/channel';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import type { ConversationInput } from '../../../src/bot/conversation-input';
import type { AgentRun } from '../../../src/agent/types';
import type { ConversationRuntime } from '../../../src/conversation/runtime';
import { SteerDeliveryTracker } from '../../../src/conversation/steer-delivery';
import { claimSteerMails, pullSteerMails, type SteerMailBatch } from '../../../src/conversation/steer-mailbox';

it.each(['unread', 'pulled', 'held'] as const)('rejected notice preserves exactly one delivery owner when body is %s', async state => {
  const root = mkdtempSync(join(tmpdir(), 'aria-notice-ownership-'));
  const pending = new PendingQueue(60_000, () => {});
  let batch: SteerMailBatch | undefined;
  try {
    const input: ConversationInput = {
      message: { messageId: 'new', chatId: 'scope', chatType: 'p2p', senderId: 'human',
        content: 'new instruction', rawContentType: 'text', createTime: Date.now(),
        resources: [], mentions: [], mentionAll: false, mentionedBot: false },
      addressing: { kind: 'direct-message', addressedToAgent: true }, senderType: 'user',
    };
    pending.block('scope'); pending.push('scope', input);
    const runs = new ActiveRuns();
    runs.register('scope', { steering: { delivery: 'none', mode: 'stdio-push' } } as unknown as AgentRun);
    let consumed = 0;
    const conversations = { trySteer: vi.fn(async () => {
      if (state === 'pulled') consumed += pullSteerMails(root, 'scope').length;
      if (state === 'held') batch = claimSteerMails(root, 'scope');
      return { kind: 'rejected', reason: 'run-ended' };
    }) } as unknown as ConversationRuntime;
    await tryMergeLiveFollowup({ conversations, activeRuns: runs, pending, scope: 'scope', input,
      inboxDir: root, steerDeliveries: new SteerDeliveryTracker<ConversationInput>() });
    batch?.release();
    consumed += pullSteerMails(root, 'scope').length;
    expect(pending.snapshot('scope')).toHaveLength(state === 'unread' ? 1 : 0);
    expect(consumed + pending.snapshot('scope').length).toBe(1);
    expect(conversations.trySteer).toHaveBeenCalledOnce();
  } finally { batch?.release(); pending.cancelAll(); rmSync(root, { recursive: true, force: true }); }
});
