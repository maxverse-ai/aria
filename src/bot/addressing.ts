import { isDmLikeTopology, type ChatTopology } from './chat-topology';

export type AddressingKind =
  | 'direct-message'
  | 'structured-mention'
  | 'interactive-callback'
  | 'exclusive-group'
  | 'ambient-group'
  | 'unknown-group';

export interface AddressingContext {
  /** Whether this message is unambiguously directed at the current agent. */
  addressedToAgent: boolean;
  kind: AddressingKind;
}

export interface AddressingInput {
  chatType: 'p2p' | 'group';
  mentionedBot: boolean;
  /** Present only when the group roster was resolved successfully. */
  topology?: ChatTopology;
}

/**
 * Derive addressing from conversation shape, not from UI-specific exceptions.
 * A reply target contributes context to the prompt but never addresses a bot.
 */
export function resolveAddressingContext(input: AddressingInput): AddressingContext {
  if (input.chatType === 'p2p') {
    return { addressedToAgent: true, kind: 'direct-message' };
  }
  if (input.mentionedBot) {
    return { addressedToAgent: true, kind: 'structured-mention' };
  }
  if (!input.topology) {
    return { addressedToAgent: false, kind: 'unknown-group' };
  }
  if (isDmLikeTopology(input.topology)) {
    return { addressedToAgent: true, kind: 'exclusive-group' };
  }
  return { addressedToAgent: false, kind: 'ambient-group' };
}
