import { describe, expect, it } from 'vitest';
import { resolveAddressingContext } from '../../../src/bot/addressing';

describe('message addressing', () => {
  it('treats direct messages and structured bot mentions as addressed', () => {
    expect(resolveAddressingContext({ chatType: 'p2p', mentionedBot: false })).toEqual({
      addressedToAgent: true,
      kind: 'direct-message',
    });
    expect(resolveAddressingContext({ chatType: 'group', mentionedBot: true })).toEqual({
      addressedToAgent: true,
      kind: 'structured-mention',
    });
  });

  it('treats a one-human one-agent group as an exclusive conversation', () => {
    expect(resolveAddressingContext({
      chatType: 'group',
      mentionedBot: false,
      topology: { humanCount: 1, botCount: 1 },
    })).toEqual({ addressedToAgent: true, kind: 'exclusive-group' });
  });

  it('does not infer addressing from ambient or unknown group context', () => {
    expect(resolveAddressingContext({
      chatType: 'group',
      mentionedBot: false,
      topology: { humanCount: 2, botCount: 1 },
    })).toEqual({ addressedToAgent: false, kind: 'ambient-group' });
    expect(resolveAddressingContext({ chatType: 'group', mentionedBot: false })).toEqual({
      addressedToAgent: false,
      kind: 'unknown-group',
    });
  });
});
