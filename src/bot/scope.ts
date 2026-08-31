import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { MessageConversationKind } from '../runtime/message-resource';
import type { ChatMode, ChatModeCache } from './chat-mode-cache';
import { lookupMessageThreadId } from './thread-id';

export interface ResolvedMessageConversation {
  message: NormalizedMessage;
  key: string;
  kind: MessageConversationKind;
  mode: ChatMode;
  resolvedMode: ChatMode;
  threadId?: string;
  threadIdBackfilled: boolean;
  modeOverridden: boolean;
}

/**
 * Resolve the canonical conversation once at message intake.
 *
 * Lark can omit `threadId` from the event that opens a topic, and chat-mode
 * lookups can lag behind a group-to-topic conversion. This resolver combines
 * both signals before audit, read projection, outbound policy, and session
 * routing consume the conversation key.
 */
export async function resolveMessageConversation(
  channel: LarkChannel,
  message: NormalizedMessage,
  cache: ChatModeCache,
): Promise<ResolvedMessageConversation> {
  const resolvedMode = await cache.resolve(channel, message.chatId);
  let threadId = message.threadId;
  let threadIdBackfilled = false;
  if (!threadId && resolvedMode === 'topic') {
    threadId = await lookupMessageThreadId(channel, message.messageId);
    threadIdBackfilled = Boolean(threadId);
  }

  const mode: ChatMode = threadId ? 'topic' : resolvedMode;
  const modeOverridden = Boolean(threadId && resolvedMode !== 'topic');
  if (modeOverridden) cache.invalidate(message.chatId);
  const kind: MessageConversationKind = message.chatType === 'p2p'
    ? 'p2p'
    : mode === 'topic'
      ? 'topic'
      : 'group';
  const key = kind === 'topic' && threadId
    ? `${message.chatId}:${threadId}`
    : message.chatId;

  return {
    message: threadId === message.threadId ? message : { ...message, threadId },
    key,
    kind,
    mode,
    resolvedMode,
    ...(threadId ? { threadId } : {}),
    threadIdBackfilled,
    modeOverridden,
  };
}

/**
 * Compute the **session scope** for a message.
 *
 *  - **p2p / group**: scope = `chatId`. Replies in regular groups thread the
 *    UI but share the chat's session (matches user expectation).
 *  - **topic group**: scope = `${chatId}:${threadId}` — each topic is an
 *    independent conversation with its own session / cwd / pending queue.
 *    Topic-group top-level messages (no threadId, rare) fall back to chatId.
 *
 * Async because chat mode requires an API lookup (cached after first hit).
 * Callers typically await this once at intake/cardAction entry and pass
 * the resolved scope through.
 */
export async function scopeFor(
  channel: LarkChannel,
  chatId: string,
  threadId: string | undefined,
  cache: ChatModeCache,
): Promise<string> {
  const mode = await cache.resolve(channel, chatId);
  if (threadId) {
    if (mode !== 'topic') cache.invalidate(chatId);
    return `${chatId}:${threadId}`;
  }
  return chatId;
}

/** Convenience overload from a NormalizedMessage. */
export async function scopeForMessage(
  channel: LarkChannel,
  msg: NormalizedMessage,
  cache: ChatModeCache,
): Promise<string> {
  return (await resolveMessageConversation(channel, msg, cache)).key;
}
