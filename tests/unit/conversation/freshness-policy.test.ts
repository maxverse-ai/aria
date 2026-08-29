import { describe, expect, it } from 'vitest';
import {
  evaluateFreshnessCandidates,
  normalizeDuplicateBody,
  type FreshnessCandidate,
} from '../../../src/conversation/freshness-policy.js';

describe('final reply freshness policy', () => {
  it('does not hold an addressed follow-up already acknowledged by the active turn', () => {
    expect(evaluate([candidate({ id: 'accepted' })], new Set(['accepted']))).toEqual({
      kind: 'fresh',
    });
  });

  it('does not let a later accepted text hide an earlier unsteerable attachment', () => {
    expect(evaluate([
      candidate({ id: 'attachment', text: '', attachmentCount: 1 }),
      candidate({ id: 'accepted-text', text: 'also do this' }),
    ], new Set(['accepted-text']))).toEqual({
      kind: 'hold',
      source: 'local',
      messageIds: ['attachment'],
      reason: 'unseen-addressed-input',
    });
  });

  it('ignores ambient group chatter and empty pings', () => {
    expect(evaluate([
      candidate({ id: 'ambient', addressedToAgent: false }),
      candidate({ id: 'ping', text: '   ' }),
    ])).toEqual({ kind: 'fresh' });
  });

  it('never treats bot-authored messages as freshness-blocking input', () => {
    expect(evaluate([
      candidate({ id: 'bot', senderType: 'bot', text: 'different output' }),
    ])).toEqual({ kind: 'fresh' });
  });

  it('suppresses an exact bot duplicate after Unicode and line-ending normalization', () => {
    expect(evaluate([
      candidate({
        id: 'other-bot',
        source: 'remote',
        senderId: 'ou_other_bot',
        senderType: 'bot',
        text: 'Cafe\u0301\r\nanswer',
      }),
    ], new Set(), 'Café\nanswer')).toEqual({
      kind: 'duplicate',
      source: 'remote',
      messageId: 'other-bot',
      reason: 'matching-bot-output',
    });
  });

  it('keeps internal whitespace exact for conservative duplicate detection', () => {
    expect(normalizeDuplicateBody(' answer  here ')).toBe('answer  here');
    expect(evaluate([
      candidate({ id: 'other-bot', senderType: 'bot', text: 'answer here' }),
    ], new Set(), 'answer  here')).toEqual({ kind: 'fresh' });
  });
});

function evaluate(
  candidates: FreshnessCandidate[],
  knownInputIds: ReadonlySet<string> = new Set(),
  draftText = 'draft',
) {
  return evaluateFreshnessCandidates({
    candidates,
    knownInputIds,
    selfBotId: 'ou_self',
    draftText,
  });
}

function candidate(
  overrides: Partial<FreshnessCandidate> & Pick<FreshnessCandidate, 'id'>,
): FreshnessCandidate {
  return {
    id: overrides.id,
    source: overrides.source ?? 'local',
    senderId: overrides.senderId ?? 'ou_user',
    senderType: overrides.senderType ?? 'user',
    addressedToAgent: overrides.addressedToAgent ?? true,
    text: overrides.text ?? 'new input',
    attachmentCount: overrides.attachmentCount ?? 0,
    rawContentType: overrides.rawContentType ?? 'text',
  };
}
