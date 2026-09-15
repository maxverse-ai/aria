import { normalizeMessage } from './message-normalization';
import {
  type ApiMessageItem,
  type LarkChannel,
  type RawMessageEvent,
} from '@larksuite/channel';
import { log } from '../core/logger';
import { resolveAddressingContext } from './addressing';
import type { ChatTopologyResolver } from './chat-topology';
import { messageTimestampMs, toConversationInput, type ConversationInput } from './conversation-input';

export type FreshnessHistoryStatus = 'complete' | 'truncated' | 'unavailable';

export interface FreshnessHistoryResult {
  status: FreshnessHistoryStatus;
  inputs: ConversationInput[];
  failure?: { code?: number; missingScope?: string };
}

const DEFAULT_MAX_MESSAGES = 100;

/**
 * Bounded REST backstop for messages the live WebSocket path may not have
 * delivered before final-reply publication. Topic scopes query their thread;
 * ordinary chats query the chat container.
 */
export async function fetchFreshnessHistory(input: {
  channel: LarkChannel;
  chatTopology: ChatTopologyResolver;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId?: string;
  afterMs: number;
  knownInputIds: ReadonlySet<string>;
  maxMessages?: number;
}): Promise<FreshnessHistoryResult> {
  const maxMessages = input.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const collected: ApiMessageItem[] = [];
  let pageToken: string | undefined;
  let truncated = false;

  try {
    do {
      const remaining = Math.max(1, maxMessages - collected.length);
      const res = await input.channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: input.threadId ? 'thread' : 'chat',
          container_id: input.threadId ?? input.chatId,
          sort_type: 'ByCreateTimeAsc',
          page_size: Math.min(50, remaining),
          start_time: String(Math.max(0, Math.floor(input.afterMs / 1000))),
          end_time: String(Math.ceil(Date.now() / 1000) + 1),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const api = res as { code?: number; msg?: string };
      if (api.code !== undefined && api.code !== 0) {
        throw Object.assign(new Error(api.msg ?? 'history request rejected'), { response: { data: api } });
      }
      const data = (res as {
        data?: {
          items?: ApiMessageItem[];
          messages?: ApiMessageItem[];
          has_more?: boolean;
          page_token?: string;
        };
      }).data;
      const items = data?.items ?? data?.messages ?? [];
      collected.push(...items.slice(0, remaining));
      const hasMore = data?.has_more === true;
      pageToken = hasMore ? data?.page_token : undefined;
      if (
        items.length > remaining ||
        (hasMore && (!data?.page_token || collected.length >= maxMessages))
      ) {
        truncated = true;
      }
    } while (pageToken && collected.length < maxMessages);
  } catch (error) {
    const failure = historyFailure(error);
    log.warn('freshness', 'history-fetch-failed', {
      ...failure,
      selfId: input.channel.botIdentity?.openId,
      chatId: input.chatId,
      threadId: input.threadId,
      err: error instanceof Error ? error.message : String(error),
    });
    return { status: 'unavailable', inputs: [], failure };
  }

  const normalized: ConversationInput[] = [];
  let normalizationFailed = false;
  for (const item of collected) {
    if (
      !item.message_id ||
      input.knownInputIds.has(item.message_id) ||
      (item as ApiMessageItem & { deleted?: boolean }).deleted
    ) {
      continue;
    }
    const rawTimestampMs = apiTimestampMs(item.create_time);
    if (rawTimestampMs > 0 && rawTimestampMs < input.afterMs) continue;
    if (rawTimestampMs === 0) normalizationFailed = true;
    const message = await normalizeHistoryItem(input.channel, item, {
      chatId: input.chatId,
      chatType: input.chatType,
      threadId: input.threadId,
    });
    if (!message) {
      normalizationFailed = true;
      continue;
    }
    const normalizedTimestampMs = messageTimestampMs(message);
    if (normalizedTimestampMs > 0 && normalizedTimestampMs < input.afterMs) continue;
    if (normalizedTimestampMs === 0) normalizationFailed = true;
    normalized.push(toConversationInput(message, resolveAddressingContext({
      chatType: input.chatType,
      mentionedBot: message.mentionedBot,
    })));
  }

  // Only unmentioned groups need roster shape. Resolve once and rewrite the
  // provisional unknown-group decisions through the same addressing resolver
  // used by live intake.
  if (
    input.chatType === 'group' &&
    normalized.some((entry) =>
      entry.senderType !== 'bot' && !entry.message.mentionedBot)
  ) {
    try {
      const topology = await input.chatTopology.resolve(input.chatId);
      for (let index = 0; index < normalized.length; index++) {
        const entry = normalized[index];
        if (!entry || entry.senderType === 'bot' || entry.message.mentionedBot) continue;
        normalized[index] = {
          ...entry,
          addressing: resolveAddressingContext({
            chatType: 'group',
            mentionedBot: false,
            topology,
          }),
        };
      }
    } catch (error) {
      normalizationFailed = true;
      log.warn('freshness', 'history-addressing-failed', {
        chatId: input.chatId,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    status: truncated ? 'truncated' : normalizationFailed ? 'unavailable' : 'complete',
    inputs: normalized,
  };
}

function apiTimestampMs(value: ApiMessageItem['create_time']): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

async function normalizeHistoryItem(
  channel: LarkChannel,
  item: ApiMessageItem,
  context: { chatId: string; chatType: 'p2p' | 'group'; threadId?: string },
): Promise<ConversationInput['message'] | undefined> {
  if (!item.message_id) return undefined;
  const raw: RawMessageEvent = {
    sender: {
      sender_id: { open_id: (item.sender as { open_bot_id?: string } | undefined)?.open_bot_id ?? item.sender?.id },
      sender_type: item.sender?.sender_type,
    },
    message: {
      message_id: item.message_id,
      chat_id: context.chatId,
      chat_type: context.chatType,
      ...(context.threadId ? { thread_id: context.threadId } : {}),
      message_type: item.msg_type ?? 'text',
      content: item.body?.content ?? '',
      create_time: item.create_time !== undefined ? String(item.create_time) : undefined,
      mentions: item.mentions,
    },
  };
  try {
    return await normalizeMessage(raw, {
      botIdentity: channel.botIdentity ?? { openId: '', name: '' },
      includeRaw: true,
    });
  } catch (error) {
    log.warn('freshness', 'history-normalize-failed', {
      messageId: item.message_id,
      err: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function historyFailure(error: unknown): { code?: number; missingScope?: string } {
  const data = (error as { response?: { data?: { code?: unknown; msg?: unknown } } } | null)?.response?.data;
  const message = typeof data?.msg === 'string' ? data.msg : error instanceof Error ? error.message : '';
  const missingScope = /need scope:\s*([a-zA-Z0-9_:.-]+)/.exec(message)?.[1];
  return { ...(typeof data?.code === 'number' ? { code: data.code } : {}), ...(missingScope ? { missingScope } : {}) };
}
