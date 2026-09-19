import { ChannelPluginError } from '@maxverse-ai/aria';
import type {
  IlinkInboundMessage,
  IlinkSendMessage,
  IlinkTransport,
  IlinkUpdatesPage,
} from './transport';

/**
 * Deterministic no-network iLink backend for contract and unit tests.
 * Mirrors get_updates_buf semantics: a served batch is redelivered until
 * the client passes the returned cursor back, so tests can prove the
 * runtime only advances the provider cursor after durable acceptance.
 */
export class FakeIlinkTransport implements IlinkTransport {
  readonly sent: IlinkSendMessage[] = [];
  notifyStartCount = 0;
  notifyStopCount = 0;
  pollCount = 0;

  private readonly queue: IlinkInboundMessage[][] = [];
  private readonly waiters: Array<() => void> = [];
  private served: { nextCursor: string; messages: IlinkInboundMessage[] } | undefined;
  private failNext: unknown;

  constructor(private readonly options: { idleMs?: number } = {}) {}

  push(messages: IlinkInboundMessage[]): void {
    this.queue.push(messages);
    for (const wake of this.waiters.splice(0)) wake();
  }

  failNextPoll(error: unknown): void {
    this.failNext = error;
    for (const wake of this.waiters.splice(0)) wake();
  }

  authFailure(): ChannelPluginError {
    return new ChannelPluginError('stale bot token', {
      kind: 'authentication',
      code: 'weixin-ilink-auth',
    });
  }

  async getUpdates(input: { cursor: string; timeoutMs: number }): Promise<IlinkUpdatesPage> {
    this.pollCount += 1;
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    this.commitIfAdvanced(input.cursor);
    if (!this.served && this.queue.length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.idleMs ?? 5);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (this.failNext) {
        const error = this.failNext;
        this.failNext = undefined;
        throw error;
      }
      this.commitIfAdvanced(input.cursor);
    }
    if (!this.served) {
      const messages = this.queue.shift() ?? [];
      this.served = {
        messages,
        nextCursor: `${input.cursor || 'c0'}>${messages.length}`,
      };
    }
    return { messages: this.served.messages, cursor: this.served.nextCursor };
  }

  private commitIfAdvanced(cursor: string): void {
    if (this.served && cursor === this.served.nextCursor) {
      this.served = undefined;
    }
  }

  async sendMessage(message: IlinkSendMessage): Promise<void> {
    this.sent.push(message);
  }

  async notifyStart(): Promise<void> {
    this.notifyStartCount += 1;
  }

  async notifyStop(): Promise<void> {
    this.notifyStopCount += 1;
  }
}
