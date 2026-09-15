import type { LarkChannelOptions } from '@larksuite/channel';

type Cache = NonNullable<LarkChannelOptions['cache']>;
type Key = Parameters<Cache['get']>[0];
type Entry = { value: unknown; expiresAt?: number };

/** Channel-owned SDK cache. No process globals or background timers.
 * SDK expiry is an absolute millisecond timestamp, not a TTL.
 * Like the SDK default this is memory-only; it is not a durable event ledger.
 */
export class LarkSdkCache implements Cache {
  private readonly namespaces = new Map<string, Map<Key, Entry>>();
  private nextSweep = 0;
  private closed = false;

  async get(key: Key, options?: { namespace?: string }): Promise<any> {
    if (this.closed) return undefined;
    const entries = this.namespaces.get(options?.namespace ?? '');
    const entry = entries?.get(key);
    if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
      entries?.delete(key);
      return undefined;
    }
    return entry?.value;
  }

  async set(key: Key, value: unknown, expiresAt?: number, options?: { namespace?: string }): Promise<boolean> {
    if (this.closed) return false;
    const now = Date.now();
    if (now >= this.nextSweep) {
      for (const [namespace, entries] of this.namespaces) {
        for (const [key, entry] of entries) {
          if (entry.expiresAt && entry.expiresAt <= now) entries.delete(key);
        }
        if (!entries.size) this.namespaces.delete(namespace);
      }
      this.nextSweep = now + 60_000;
    }
    const namespace = options?.namespace ?? '';
    let entries = this.namespaces.get(namespace);
    if (!entries) this.namespaces.set(namespace, entries = new Map());
    entries.set(key, { value, expiresAt });
    return true;
  }

  close(): void {
    this.closed = true;
    this.namespaces.clear();
  }
}
