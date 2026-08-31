import { createHash } from 'node:crypto';
import { parseWechatKfCommand } from './commands';
import { FileWechatKfMessageInbox } from './message-inbox';
import type { WechatKfMessageSink } from './processor';
import { wechatKfScopeId } from './session';
import type { WechatKfMessage } from './types';

export interface WechatKfDurableMessageSinkOptions {
  inbox: FileWechatKfMessageInbox;
  handler: WechatKfMessageSink;
  sessionHmacSecret: string;
  onProcessingError?: (error: unknown, context: WechatKfProcessingErrorContext) => void;
}

export interface WechatKfProcessingErrorContext {
  scopeId: string;
  sourceMessageKey: string;
}

/**
 * Durably accepts messages before the sync cursor advances, then keeps normal
 * questions serial per user while commands use a separate per-user lane.
 */
export class WechatKfDurableMessageSink implements WechatKfMessageSink {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly normalTails = new Map<string, Promise<void>>();
  private readonly controlTails = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly options: WechatKfDurableMessageSinkOptions) {
    if (!options.sessionHmacSecret) throw new Error('wxkf session HMAC secret is required');
  }

  async accept(message: WechatKfMessage): Promise<void> {
    if (this.closed) throw new Error('wxkf durable message sink is closed');
    await this.options.inbox.enqueue(message);
    this.schedule(message);
  }

  /** Schedule messages that were durably accepted before a prior process exit. */
  async recover(): Promise<number> {
    if (this.closed) throw new Error('wxkf durable message sink is closed');
    const messages = await this.options.inbox.list();
    for (const message of messages) this.schedule(message);
    return messages.length;
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.waitForIdle();
  }

  private schedule(message: WechatKfMessage): void {
    if (this.inFlight.has(message.msgid)) return;
    const scopeId = messageScopeId(this.options.sessionHmacSecret, message);
    const tails = isControlMessage(message) ? this.controlTails : this.normalTails;
    const previous = tails.get(scopeId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.process(message))
      .catch((error: unknown) => {
        this.options.onProcessingError?.(error, {
          scopeId,
          sourceMessageKey: createHash('sha256')
            .update(`wxkf-processing-error:v1:${message.msgid}`)
            .digest('base64url'),
        });
      })
      .finally(() => {
        if (this.inFlight.get(message.msgid) === operation) this.inFlight.delete(message.msgid);
        if (tails.get(scopeId) === operation) tails.delete(scopeId);
      });
    this.inFlight.set(message.msgid, operation);
    tails.set(scopeId, operation);
  }

  private async process(message: WechatKfMessage): Promise<void> {
    await this.options.handler.accept(message);
    await this.options.inbox.remove(message.msgid);
  }
}

function isControlMessage(message: WechatKfMessage): boolean {
  return message.origin === 3 && message.msgtype === 'text' &&
    Boolean(message.text?.content && parseWechatKfCommand(message.text.content));
}

function messageScopeId(secret: string, message: WechatKfMessage): string {
  if (message.open_kfid && message.external_userid) {
    return wechatKfScopeId(secret, message.open_kfid, message.external_userid);
  }
  return `wechat-kf:unroutable:${message.msgid}`;
}
