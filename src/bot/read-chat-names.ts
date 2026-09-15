import type { LarkChannel } from '@larksuite/channel';

/** Per-channel/account presentation cache. A lookup failure never blocks intake. */
export class ReadChatNames {
  private readonly names = new Map<string, { name?: string; until: number }>();
  private readonly pending = new Map<string, Promise<string | undefined>>();
  constructor(private readonly channel: Pick<LarkChannel, 'getChatInfo'>, private readonly now = Date.now,
    private readonly timeoutMs = 800) {}
  async get(chatId: string): Promise<string | undefined> {
    const cached = this.names.get(chatId);
    if (cached && cached.until > this.now()) return cached.name;
    const pending = this.pending.get(chatId); if (pending) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = Promise.race([
      this.channel.getChatInfo(chatId).then(info => info.name?.trim() || undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), this.timeoutMs); }),
    ]).catch(() => undefined).then(name => {
      if (this.names.size >= 500) this.names.delete(this.names.keys().next().value!);
      this.names.set(chatId, { name: name ?? cached?.name, until: this.now() + (name ? 300_000 : 60_000) });
      return name ?? cached?.name;
    }).finally(() => { clearTimeout(timer); this.pending.delete(chatId); });
    this.pending.set(chatId, request); return request;
  }
}
