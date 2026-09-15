import type { LarkChannel } from '@larksuite/channel';

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
