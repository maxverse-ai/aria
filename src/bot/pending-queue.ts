import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';
import { TurnInbox, type TurnInboxClaim } from '../conversation/turn-inbox';

export type FlushHandler = (scope: string, batch: NormalizedMessage[]) => void;

/**
 * Per-scope debounce queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 * Accumulates messages within the same scope inside a quiet window, then
 * flushes as a single batch.
 *
 * `block(scope)` pauses the debounce timer while an agent run is active on
 * that scope — pushed messages still accumulate but no flush fires until
 * `unblock(scope)`, which arms a fresh quiet window.
 *
 * Commands should bypass this queue — they're cheap and should be responsive.
 */
export class PendingQueue {
  private readonly inbox: TurnInbox<NormalizedMessage>;
  private anonymousId = 0;
  private readonly anonymousKeys = new WeakMap<NormalizedMessage, string>();

  constructor(delayMs: number, onFlush: FlushHandler) {
    this.inbox = new TurnInbox(delayMs, (scope, messages) => {
      try {
        onFlush(scope, messages);
      } catch (err) {
        log.fail('queue', err, { scope, batchSize: messages.length });
      }
    });
  }

  push(scope: string, msg: NormalizedMessage): number {
    return this.inbox.offer(scope, this.keyFor(msg), msg).size;
  }

  claim(
    scope: string,
    messages: readonly NormalizedMessage[],
    claimId: string,
  ): TurnInboxClaim<NormalizedMessage> | undefined {
    return this.inbox.claim(scope, messages.map((message) => this.keyFor(message)), claimId);
  }

  acknowledge(claim: TurnInboxClaim<NormalizedMessage>): number {
    return this.inbox.acknowledge(claim);
  }

  release(claim: TurnInboxClaim<NormalizedMessage>): number {
    return this.inbox.release(claim);
  }

  cancel(scope: string): NormalizedMessage[] {
    return this.inbox.cancel(scope);
  }

  cancelAll(): void {
    this.inbox.cancelAll();
  }

  activitySnapshot(): {
    pendingMessages: number;
    pendingScopes: number;
    blockedScopes: number;
  } {
    const { claimedMessages: _claimedMessages, ...snapshot } = this.inbox.activitySnapshot();
    return snapshot;
  }

  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope: string): void {
    this.inbox.block(scope);
    log.info('queue', 'blocked', { scope, queued: this.inbox.size(scope) });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    this.inbox.unblock(scope);
    log.info('queue', 'unblocked', { scope, queued: this.inbox.size(scope) });
  }

  private keyFor(msg: NormalizedMessage): string {
    const messageId = typeof msg.messageId === 'string' ? msg.messageId.trim() : '';
    if (messageId) return messageId;
    const existing = this.anonymousKeys.get(msg);
    if (existing) return existing;
    this.anonymousId++;
    const key = `anonymous:${this.anonymousId}`;
    this.anonymousKeys.set(msg, key);
    return key;
  }
}
