import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';
import { TurnInbox, type TurnInboxClaim } from '../conversation/turn-inbox';
import type { ConversationInput } from './conversation-input';

export type FlushHandler = (scope: string, batch: ConversationInput[]) => void;

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
  private readonly inbox: TurnInbox<ConversationInput>;
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

  push(scope: string, input: ConversationInput): number {
    return this.inbox.offer(scope, this.keyFor(input.message), input).size;
  }

  claim(
    scope: string,
    inputs: readonly ConversationInput[],
    claimId: string,
  ): TurnInboxClaim<ConversationInput> | undefined {
    return this.inbox.claim(
      scope,
      inputs.map((input) => this.keyFor(input.message)),
      claimId,
    );
  }

  acknowledge(claim: TurnInboxClaim<ConversationInput>): number {
    return this.inbox.acknowledge(claim);
  }

  release(claim: TurnInboxClaim<ConversationInput>): number {
    return this.inbox.release(claim);
  }

  cancel(scope: string): ConversationInput[] {
    return this.inbox.cancel(scope);
  }

  snapshot(scope: string): ConversationInput[] {
    return this.inbox.snapshot(scope);
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
