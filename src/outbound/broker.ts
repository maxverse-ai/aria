import type { OutboundEnvelope } from './types';
import type { MessageAuditSink } from '../runtime/message-audit';
import type { MessageResourceSink } from '../runtime/message-resource';
import { log } from '../core/logger';

export interface OutboundBrokerOptions {
  messageAudit?: MessageAuditSink;
  messageRead?: MessageResourceSink;
  now?: () => Date;
}

/**
 * The single dispatch point for Aria-managed outbound operations.
 *
 * Phase one is deliberately pass-through: it changes routing, not behaviour.
 * A later optional policy can make allow/replace/block decisions here without
 * exposing the concrete Lark channel to that policy.
 */
export class OutboundBroker {
  private closed = false;
  private inFlight = 0;
  private streams = 0;
  constructor(private readonly options: OutboundBrokerOptions = {}) {}

  async dispatch<T>(envelope: OutboundEnvelope, perform: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error(`outbound broker is closed (${envelope.sink})`);
    }
    this.inFlight++;
    if (envelope.sink === 'message.stream') this.streams++;
    try {
      const result = await perform();
      if (
        (envelope.sink === 'message.send' || envelope.sink === 'message.stream')
        && (this.options.messageAudit || this.options.messageRead)
      ) {
        const receiptId = messageReceiptId(result);
        const eventId = `outbound:${receiptId ?? `${envelope.context.operationId}:${this.options.now?.().toISOString() ?? new Date().toISOString()}`}`;
        const occurredAt = (this.options.now ?? (() => new Date()))().toISOString();
        await this.options.messageAudit?.record({
          eventId,
          direction: 'outbound',
          conversationKey: envelope.context.conversationId,
          occurredAt,
          ...(receiptId ? { sourceMessageId: receiptId } : {}),
        }).catch((err) => log.warn('outbound', 'audit-write-failed', {
          sink: envelope.sink,
          err: err instanceof Error ? err.message : String(err),
        }));
        if (receiptId) {
          await this.options.messageRead?.observe({
            eventId,
            sourceMessageId: receiptId,
            direction: 'outbound',
            conversationKey: envelope.context.conversationId,
            correlationId: envelope.context.operationId,
            occurredAt,
            content: envelope.sink === 'message.send'
              ? outboundContent(envelope.payload)
              : { format: 'unavailable' },
          }).catch((err) => log.warn('outbound', 'message-projection-failed', {
            err: err instanceof Error ? err.message : String(err),
          }));
        }
      }
      return result;
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      if (envelope.sink === 'message.stream') this.streams = Math.max(0, this.streams - 1);
    }
  }

  activitySnapshot(): { outboundInFlight: number; streamingReplies: number } {
    return { outboundInFlight: this.inFlight, streamingReplies: this.streams };
  }

  close(): void {
    this.closed = true;
  }
}

function messageReceiptId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = (result as { messageId?: unknown }).messageId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function outboundContent(payload: unknown): { format: 'plain-text' | 'markdown' | 'structured' | 'unavailable'; text?: string } {
  if (!payload || typeof payload !== 'object') return { format: 'unavailable' };
  const input = (payload as { input?: unknown }).input;
  if (!input || typeof input !== 'object') return { format: 'unavailable' };
  const record = input as Record<string, unknown>;
  if (typeof record.text === 'string') return { format: 'plain-text', text: record.text };
  if (typeof record.markdown === 'string') return { format: 'markdown', text: record.markdown };
  return { format: 'structured' };
}
