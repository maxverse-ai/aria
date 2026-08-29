export interface TurnInboxClaim<T> {
  scope: string;
  claimId: string;
  items: Array<{ key: string; value: T }>;
}

interface InboxItem<T> {
  key: string;
  value: T;
  claimedBy?: string;
}

interface InboxScope<T> {
  items: Map<string, InboxItem<T>>;
  timer?: NodeJS.Timeout;
}

export type TurnInboxFlushHandler<T> = (scope: string, values: T[]) => void;

/**
 * Ordered, per-conversation ownership boundary for inbound turn messages.
 *
 * An item is offered once and can then take exactly one of two paths:
 * debounce-flush into the next turn, or claim -> acknowledge after a live-turn
 * steering transport confirms delivery. A failed steering attempt releases the
 * claim and makes the same item eligible for the next-turn flush again.
 */
export class TurnInbox<T> {
  private readonly scopes = new Map<string, InboxScope<T>>();
  private readonly blocked = new Set<string>();

  constructor(
    private readonly delayMs: number,
    private readonly onFlush: TurnInboxFlushHandler<T>,
  ) {}

  offer(scope: string, key: string, value: T): { accepted: boolean; size: number } {
    let entry = this.scopes.get(scope);
    if (!entry) {
      entry = { items: new Map() };
      this.scopes.set(scope, entry);
    }
    if (entry.items.has(key)) return { accepted: false, size: entry.items.size };

    entry.items.set(key, { key, value });
    this.rearm(scope, entry);
    return { accepted: true, size: entry.items.size };
  }

  claim(scope: string, keys: readonly string[], claimId: string): TurnInboxClaim<T> | undefined {
    const entry = this.scopes.get(scope);
    if (!entry || keys.length === 0) return;

    const uniqueKeys = [...new Set(keys)];
    const items: Array<{ key: string; value: T }> = [];
    for (const key of uniqueKeys) {
      const item = entry.items.get(key);
      if (!item || item.claimedBy) return;
      items.push({ key, value: item.value });
    }
    for (const { key } of items) {
      const item = entry.items.get(key);
      if (item) item.claimedBy = claimId;
    }
    this.rearm(scope, entry);
    return { scope, claimId, items };
  }

  acknowledge(claim: TurnInboxClaim<T>): number {
    const entry = this.scopes.get(claim.scope);
    if (!entry) return 0;
    let removed = 0;
    for (const { key } of claim.items) {
      const item = entry.items.get(key);
      if (item?.claimedBy !== claim.claimId) continue;
      entry.items.delete(key);
      removed++;
    }
    this.finishMutation(claim.scope, entry);
    return removed;
  }

  release(claim: TurnInboxClaim<T>): number {
    const entry = this.scopes.get(claim.scope);
    if (!entry) return 0;
    let released = 0;
    for (const { key } of claim.items) {
      const item = entry.items.get(key);
      if (item?.claimedBy !== claim.claimId) continue;
      item.claimedBy = undefined;
      released++;
    }
    this.finishMutation(claim.scope, entry);
    return released;
  }

  cancel(scope: string): T[] {
    const entry = this.scopes.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.scopes.delete(scope);
    return [...entry.items.values()].map((item) => item.value);
  }

  cancelAll(): void {
    for (const entry of this.scopes.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.scopes.clear();
    this.blocked.clear();
  }

  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.scopes.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  unblock(scope: string): void {
    if (!this.blocked.delete(scope)) return;
    const entry = this.scopes.get(scope);
    if (entry) this.rearm(scope, entry);
  }

  size(scope: string): number {
    return this.scopes.get(scope)?.items.size ?? 0;
  }

  activitySnapshot(): {
    pendingMessages: number;
    pendingScopes: number;
    blockedScopes: number;
    claimedMessages: number;
  } {
    let pendingMessages = 0;
    let claimedMessages = 0;
    for (const entry of this.scopes.values()) {
      pendingMessages += entry.items.size;
      for (const item of entry.items.values()) {
        if (item.claimedBy) claimedMessages++;
      }
    }
    return {
      pendingMessages,
      pendingScopes: this.scopes.size,
      blockedScopes: this.blocked.size,
      claimedMessages,
    };
  }

  private finishMutation(scope: string, entry: InboxScope<T>): void {
    if (entry.items.size === 0) {
      if (entry.timer) clearTimeout(entry.timer);
      this.scopes.delete(scope);
      return;
    }
    this.rearm(scope, entry);
  }

  private rearm(scope: string, entry: InboxScope<T>): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (this.blocked.has(scope) || !hasUnclaimed(entry)) return;
    entry.timer = setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string): void {
    const entry = this.scopes.get(scope);
    if (!entry || this.blocked.has(scope)) return;
    entry.timer = undefined;

    const values: T[] = [];
    for (const [key, item] of entry.items) {
      if (item.claimedBy) continue;
      values.push(item.value);
      entry.items.delete(key);
    }
    if (entry.items.size === 0) this.scopes.delete(scope);
    if (values.length > 0) this.onFlush(scope, values);
  }
}

function hasUnclaimed<T>(entry: InboxScope<T>): boolean {
  for (const item of entry.items.values()) {
    if (!item.claimedBy) return true;
  }
  return false;
}
