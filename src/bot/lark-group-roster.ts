import type { ChatMember, LarkChannel } from '@larksuite/channel';

/** Feishu returns this code when the app lacks every chat member-list scope
 * (im:chat:readonly / im:chat / im:chat.members:read / ...). The grant is
 * app-wide and cannot appear while a process runs, so callers may treat it
 * as permanent for the process lifetime. */
const ROSTER_SCOPE_DENIED_CODE = 99991672;

interface RosterPage {
  code?: number;
  data?: {
    items?: Array<{ member_id?: string; member_id_type?: string; name?: string; tenant_key?: string; bot_id?: string }>;
    has_more?: boolean;
    page_token?: string;
  };
}

function isRosterDenied(response?: RosterPage, error?: unknown): boolean {
  if (response?.code === ROSTER_SCOPE_DENIED_CODE) return true;
  if (error && typeof error === 'object') {
    const data = (error as { response?: { data?: { code?: number } } }).response?.data;
    if (data?.code === ROSTER_SCOPE_DENIED_CODE) return true;
    if ((error as { code?: number }).code === ROSTER_SCOPE_DENIED_CODE) return true;
  }
  const text = error instanceof Error ? error.message : String(error);
  return text.includes(String(ROSTER_SCOPE_DENIED_CODE));
}

/**
 * User roster with display names — the shape the channel SDK's
 * `resolveChatMembers` hook consumes for sender-name resolution.
 * Returns `'denied'` when the app lacks the member-list scope so the caller
 * can short-circuit instead of paying a guaranteed-failing REST call on every
 * inbound message.
 */
export async function readLarkMemberRoster(
  channel: Pick<LarkChannel, 'rawClient'>,
  chatId: string,
): Promise<ChatMember[] | 'denied'> {
  const members: ChatMember[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    let response: RosterPage;
    try {
      response = await channel.rawClient.request({
        url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`,
        method: 'GET',
        params: { member_id_type: 'open_id', page_size: 100, ...(cursor ? { page_token: cursor } : {}) },
      }) as RosterPage;
    } catch (error) {
      if (isRosterDenied(undefined, error)) return 'denied';
      throw error;
    }
    if (isRosterDenied(response)) return 'denied';
    if (response.code !== undefined && response.code !== 0) throw new Error(`roster rejected: code=${response.code}`);
    const data = response.data;
    if (!Array.isArray(data?.items)) throw new Error('roster incomplete');
    for (const item of data.items) {
      if (!item.member_id) continue;
      members.push({
        id: item.member_id,
        idType: (item.member_id_type ?? 'open_id') as ChatMember['idType'],
        ...(item.name ? { name: item.name } : {}),
        ...(item.tenant_key ? { tenantKey: item.tenant_key } : {}),
      });
    }
    if (data.has_more !== true || !data.page_token) return members;
    cursor = data.page_token;
  }
  throw new Error('roster page limit exceeded');
}

/** Read complete provider identities, including pagination evidence. Never use the SDK count cache for access. */
export async function readLarkRoster(channel: Pick<LarkChannel, 'rawClient'>, chatId: string, kind: 'users' | 'bots'): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const response = await channel.rawClient.request({
      url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members${kind === 'bots' ? '/bots' : ''}`,
      method: 'GET', params: { member_id_type: 'open_id', page_size: 100, ...(cursor ? { page_token: cursor } : {}) },
    }) as { code?: number; data?: { items?: Array<{ member_id?: string; member_id_type?: string; bot_id?: string }>; has_more?: boolean; page_token?: string } };
    if (response.code !== undefined && response.code !== 0) throw new Error('roster rejected');
    const data = response.data;
    if (!Array.isArray(data?.items)) throw new Error('roster incomplete');
    for (const item of data.items) {
      const id = kind === 'bots' ? item.bot_id : item.member_id;
      if (!id || (kind === 'users' && item.member_id_type && item.member_id_type !== 'open_id')) throw new Error('roster identity is unavailable');
      ids.push(id);
    }
    if (data.has_more === false || (kind === 'bots' && data.has_more === undefined)) return ids;
    if (data.has_more !== true || !data.page_token || seen.has(data.page_token)) throw new Error('roster pagination incomplete');
    cursor = data.page_token; seen.add(cursor);
  }
  throw new Error('roster page limit exceeded');
}
