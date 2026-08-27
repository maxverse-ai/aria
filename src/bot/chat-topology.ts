import type { LarkChannel } from '@larksuite/channel';

export interface ChatTopology {
  humanCount: number;
  botCount: number;
}

export interface ChatTopologyResolverOptions {
  /** A DM-like result is safety-sensitive, so keep it fresh. */
  dmLikeTtlMs?: number;
  /** Non-DM-like groups can be cached longer without leaking group chatter. */
  groupTtlMs?: number;
  now?: () => number;
}

type ChatRosterClient = Pick<LarkChannel, 'getChatMembers' | 'getChatBots'>;

interface CachedTopology {
  value: ChatTopology;
  expiresAt: number;
}

const DEFAULT_DM_LIKE_TTL_MS = 15_000;
const DEFAULT_GROUP_TTL_MS = 60_000;

/**
 * Resolves the membership shape of a group without coupling membership APIs
 * to the message-access policy. Refreshes bypass the SDK's longer roster cache
 * so a newly-added member cannot leave a DM-like decision stale for minutes.
 */
export class ChatTopologyResolver {
  private readonly cache = new Map<string, CachedTopology>();
  private readonly inFlight = new Map<string, Promise<ChatTopology>>();
  private readonly dmLikeTtlMs: number;
  private readonly groupTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly client: ChatRosterClient,
    opts: ChatTopologyResolverOptions = {},
  ) {
    this.dmLikeTtlMs = opts.dmLikeTtlMs ?? DEFAULT_DM_LIKE_TTL_MS;
    this.groupTtlMs = opts.groupTtlMs ?? DEFAULT_GROUP_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async resolve(chatId: string): Promise<ChatTopology> {
    const cached = this.cache.get(chatId);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const pending = this.inFlight.get(chatId);
    if (pending) return pending;

    const refresh = this.refresh(chatId).finally(() => {
      this.inFlight.delete(chatId);
    });
    this.inFlight.set(chatId, refresh);
    return refresh;
  }

  invalidate(chatId: string): void {
    this.cache.delete(chatId);
  }

  private async refresh(chatId: string): Promise<ChatTopology> {
    const [humans, bots] = await Promise.all([
      this.client.getChatMembers(chatId, { force: true }),
      this.client.getChatBots(chatId, { force: true }),
    ]);
    const value = {
      humanCount: humans.length,
      botCount: bots.length,
    };
    const ttlMs = isDmLikeTopology(value) ? this.dmLikeTtlMs : this.groupTtlMs;
    this.cache.set(chatId, { value, expiresAt: this.now() + ttlMs });
    return value;
  }
}

export function isDmLikeTopology(topology: ChatTopology): boolean {
  return topology.humanCount === 1 && topology.botCount === 1;
}
