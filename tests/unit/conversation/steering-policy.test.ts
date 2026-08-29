import { describe, expect, it } from 'vitest';
import { decideSteering } from '../../../src/conversation/steering-policy';

const support = { mode: 'direct' as const, textOnly: true };

describe('steering policy', () => {
  it('keeps upgrades backward-safe and unsupported engines queued', () => {
    expect(decideSteering(facts({ preference: 'off' }))).toEqual({
      kind: 'queue',
      reason: 'disabled',
    });
    expect(decideSteering(facts({ preference: 'on', support: undefined }))).toEqual({
      kind: 'queue',
      reason: 'unsupported',
    });
  });

  it('uses mention-aware auto mode without changing the ordinary access gate', () => {
    expect(decideSteering(facts({ preference: 'auto', chatType: 'p2p' }))).toEqual({ kind: 'attempt' });
    expect(decideSteering(facts({
      preference: 'auto',
      chatType: 'group',
      mentionedBot: false,
    }))).toEqual({ kind: 'queue', reason: 'group-not-mentioned' });
    expect(decideSteering(facts({
      preference: 'auto',
      chatType: 'group',
      mentionedBot: true,
    }))).toEqual({ kind: 'attempt' });
    expect(decideSteering(facts({
      preference: 'on',
      chatType: 'group',
      mentionedBot: false,
    }))).toEqual({ kind: 'attempt' });
  });

  it('shadows eligible traffic without consuming the message', () => {
    expect(decideSteering(facts({ preference: 'shadow' }))).toEqual({ kind: 'shadow' });
  });

  it('keeps bot, attachment, non-text, empty, and oversized messages on the next turn', () => {
    expect(decideSteering(facts({ preference: 'on', senderType: 'bot' })))
      .toEqual({ kind: 'queue', reason: 'bot-sender' });
    expect(decideSteering(facts({ preference: 'on', attachmentCount: 1 })))
      .toEqual({ kind: 'queue', reason: 'attachments' });
    expect(decideSteering(facts({ preference: 'on', rawContentType: 'merge_forward' })))
      .toEqual({ kind: 'queue', reason: 'non-text' });
    expect(decideSteering(facts({ preference: 'on', text: '  ' })))
      .toEqual({ kind: 'queue', reason: 'empty' });
    expect(decideSteering(facts({ preference: 'on', text: '界'.repeat(11_000) })))
      .toEqual({ kind: 'queue', reason: 'too-large' });
  });
});

function facts(overrides: Partial<Parameters<typeof decideSteering>[0]> = {}) {
  return {
    preference: 'auto' as const,
    support,
    chatType: 'p2p' as const,
    senderType: 'user' as const,
    mentionedBot: false,
    text: 'please change direction',
    attachmentCount: 0,
    ...overrides,
  };
}
