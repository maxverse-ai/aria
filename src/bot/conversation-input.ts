import type { NormalizedMessage } from '@larksuite/channel';
import type { AddressingContext } from './addressing';

export type ConversationSenderType = 'user' | 'bot';

/**
 * A message after channel access and addressing have been resolved.
 *
 * Keeping this envelope in the inbox prevents send-time coordination from
 * re-fetching group topology (and potentially reaching a different addressing
 * decision) after the message has already entered the conversation.
 */
export interface ConversationInput {
  personalGroup?: import('./personal-agent-group').PersonalGroupAdmission;
  spaceOperation?: import('../space/operation-gate').SpaceOperation;
  message: NormalizedMessage;
  addressing: AddressingContext;
  senderType?: ConversationSenderType;
}

export function toConversationInput(
  message: NormalizedMessage,
  addressing: AddressingContext,
): ConversationInput {
  const senderType = senderTypeOf(message);
  return {
    message,
    addressing,
    ...(senderType ? { senderType } : {}),
  };
}

/** Human/bot classification from the normalized SDK signal, with legacy raw fallback. */
export function senderTypeOf(
  message: NormalizedMessage,
): ConversationSenderType | undefined {
  if (message.senderType === 'user') return 'user';
  if (message.senderType === 'bot' || message.senderType === 'app') return 'bot';
  if (message.senderIsBot === true) return 'bot';

  const raw = message.raw as { sender?: { sender_type?: unknown } } | undefined;
  const rawType = raw?.sender?.sender_type;
  if (rawType === 'user') return 'user';
  if (rawType === 'app' || rawType === 'bot') return 'bot';
  return undefined;
}

/** Normalize SDK/API timestamps to milliseconds without guessing invalid values. */
export function messageTimestampMs(message: Pick<NormalizedMessage, 'createTime'>): number {
  const value = Number(message.createTime);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

/** Call only after normal channel/space access admission. */
export function isAdmittedPeer(input: ConversationInput): boolean {
  return input.senderType === 'bot' && input.addressing.kind === 'structured-mention'
    && input.addressing.addressedToAgent;
}
