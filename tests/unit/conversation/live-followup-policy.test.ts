import { describe, expect, it } from 'vitest';
import { decideLiveFollowup } from '../../../src/conversation/live-followup-policy';

const support = { mode: 'direct' as const, textOnly: true };

describe('live follow-up policy', () => {
  it('automatically attempts supported messages addressed to the agent', () => {
    expect(decideLiveFollowup(facts())).toEqual({ kind: 'attempt' });
  });

  it('queues unsupported and ambient messages for the next turn', () => {
    expect(decideLiveFollowup(facts({ support: undefined }))).toEqual({
      kind: 'queue',
      reason: 'unsupported',
    });
    expect(decideLiveFollowup(facts({ addressedToAgent: false }))).toEqual({
      kind: 'queue',
      reason: 'not-addressed',
    });
  });

  it('queues bot, attachment, non-text, empty, and oversized messages', () => {
    expect(decideLiveFollowup(facts({ senderType: 'bot' })))
      .toEqual({ kind: 'queue', reason: 'bot-sender' });
    expect(decideLiveFollowup(facts({ attachmentCount: 1 })))
      .toEqual({ kind: 'queue', reason: 'attachments' });
    expect(decideLiveFollowup(facts({ rawContentType: 'merge_forward' })))
      .toEqual({ kind: 'queue', reason: 'non-text' });
    expect(decideLiveFollowup(facts({ text: '  ' })))
      .toEqual({ kind: 'queue', reason: 'empty' });
    expect(decideLiveFollowup(facts({ text: '界'.repeat(11_000) })))
      .toEqual({ kind: 'queue', reason: 'too-large' });
  });
});

function facts(overrides: Partial<Parameters<typeof decideLiveFollowup>[0]> = {}) {
  return {
    support,
    addressedToAgent: true,
    senderType: 'user' as const,
    text: 'please apply this additional constraint',
    attachmentCount: 0,
    ...overrides,
  };
}
