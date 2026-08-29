import { describe, expect, it, vi } from 'vitest';
import { FinalReplyCommit } from '../../../src/bot/final-reply-commit.js';
import type { FinalReplyFreshness } from '../../../src/bot/final-reply-freshness.js';
import type { ConversationRuntime } from '../../../src/conversation/runtime.js';
import type { FreshnessDecision } from '../../../src/conversation/freshness-policy.js';

describe('FinalReplyCommit', () => {
  it('does not call the publisher when preflight holds the draft', async () => {
    const h = harness(hold());
    const publish = vi.fn(async () => ({ messageId: 'om_final' }));

    await expect(h.commit.publish('draft', publish)).resolves.toMatchObject({ kind: 'hold' });
    expect(publish).not.toHaveBeenCalled();
    expect(h.retract).not.toHaveBeenCalled();
  });

  it('publishes on fail-open', async () => {
    const h = harness({ kind: 'fail-open', reason: 'history-unavailable' });
    const publish = vi.fn(async () => ({ messageId: 'om_final' }));

    await expect(h.commit.publish('draft', publish)).resolves.toEqual({
      kind: 'fail-open',
      reason: 'history-unavailable',
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(h.retract).not.toHaveBeenCalled();
  });

  it('retracts a just-published reply when local postflight sees a race', async () => {
    const h = harness({ kind: 'fresh' }, hold());

    await expect(h.commit.publish('draft', async () => ({ messageId: 'om_final' })))
      .resolves.toMatchObject({ kind: 'hold' });
    expect(h.retract).toHaveBeenCalledWith({ messageId: 'om_final' });
    expect(h.markHandoffDelivery).toHaveBeenLastCalledWith(
      'scope',
      'run-1',
      'retracted',
    );
  });

  it('reconciles an already-streamed terminal through the same decision seam', async () => {
    const h = harness({
      kind: 'duplicate',
      source: 'remote',
      messageId: 'om_other_bot',
      reason: 'matching-bot-output',
    });

    await expect(h.commit.reconcileExisting(
      'draft',
      Promise.resolve({ messageId: 'om_stream' }),
    )).resolves.toMatchObject({ kind: 'duplicate' });
    await vi.waitFor(() => expect(h.retract).toHaveBeenCalledWith({ messageId: 'om_stream' }));
  });

  it('marks a raced draft as possibly visible when retraction cannot be confirmed', async () => {
    const h = harness({ kind: 'fresh' }, hold(), false);

    await expect(h.commit.publish('draft', async () => ({ messageId: 'om_final' })))
      .resolves.toMatchObject({ kind: 'hold' });
    expect(h.markHandoffDelivery).toHaveBeenLastCalledWith(
      'scope',
      'run-1',
      'possibly-visible',
    );
  });
});

function harness(
  preflight: FreshnessDecision,
  postflight: FreshnessDecision = { kind: 'fresh' },
  retractResult = true,
) {
  const turn = {
    scopeId: 'scope',
    runId: 'run-1',
    initialWatermarkMs: 1,
    knownInputIds: new Set(['initial']),
  };
  const conversations = {
    finalizeTurn: vi.fn(async (
      _scope: string,
      _runId: string,
      operation: (value: typeof turn) => Promise<unknown>,
    ) => operation(turn)),
  } as unknown as ConversationRuntime;
  const markHandoffDelivery = vi.fn();
  const freshness = {
    inspect: vi.fn(async () => preflight),
    inspectLocal: vi.fn(() => postflight),
    markHandoffDelivery,
  } as unknown as FinalReplyFreshness;
  const retract = vi.fn(async () => retractResult);
  const commit = new FinalReplyCommit({
    conversations,
    freshness,
    context: {
      scope: 'scope',
      runId: 'run-1',
      chatId: 'oc_chat',
      chatType: 'p2p',
    },
    retract,
  });
  return { commit, retract, markHandoffDelivery };
}

function hold(): FreshnessDecision {
  return {
    kind: 'hold',
    source: 'local',
    messageIds: ['late'],
    reason: 'unseen-addressed-input',
  };
}
