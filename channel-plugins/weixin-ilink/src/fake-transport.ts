import { ChannelPluginError } from '@maxverse-ai/aria';
import type {
  IlinkLoginService,
  IlinkQrSession,
  IlinkQrStatus,
} from './login';
import type {
  IlinkAccountConfig,
  IlinkGetConfigInput,
  IlinkInboundMessage,
  IlinkSendMessage,
  IlinkSendTypingInput,
  IlinkTransport,
  IlinkUpdatesPage,
} from './transport';

/**
 * Deterministic no-network iLink backend for contract and unit tests.
 * Mirrors get_updates_buf semantics: a served batch is redelivered until
 * the client passes the returned cursor back, so tests can prove the
 * runtime only advances the provider cursor after durable acceptance.
 */
export class FakeIlinkTransport implements IlinkTransport, IlinkLoginService {
  readonly sent: IlinkSendMessage[] = [];
  readonly typing: IlinkSendTypingInput[] = [];
  readonly configCalls: IlinkGetConfigInput[] = [];
  notifyStartCount = 0;
  notifyStopCount = 0;
  pollCount = 0;
  qrSessionCount = 0;
  qrStatusCount = 0;
  lastLocalTokenList: string[] = [];
  lastPollTimeoutMs = 0;
  /** Hint echoed back as longpolling_timeout_ms on every page. */
  pollTimeoutHintMs: number | undefined;

  private readonly queue: IlinkInboundMessage[][] = [];
  private readonly waiters: Array<() => void> = [];
  private served: { nextCursor: string; messages: IlinkInboundMessage[] } | undefined;
  private failNext: unknown;
  private failSend: unknown;
  private holdSend = false;
  private readonly sendWaiters: Array<() => void> = [];
  private qrScript: IlinkQrStatus[] = [{ status: 'confirmed' }];

  constructor(private readonly options: { idleMs?: number } = {}) {}

  push(messages: IlinkInboundMessage[]): void {
    this.queue.push(messages);
    for (const wake of this.waiters.splice(0)) wake();
  }

  failNextPoll(error: unknown): void {
    this.failNext = error;
    for (const wake of this.waiters.splice(0)) wake();
  }

  failNextSend(error: unknown): void {
    this.failSend = error;
  }

  /** The next sendMessage parks until releaseSends — used for drain tests. */
  holdNextSend(): void {
    this.holdSend = true;
  }

  releaseSends(): void {
    for (const release of this.sendWaiters.splice(0)) release();
  }

  authFailure(): ChannelPluginError {
    return new ChannelPluginError('stale bot token', {
      kind: 'authentication',
      code: 'weixin-ilink-auth',
    });
  }

  async getUpdates(input: { cursor: string; timeoutMs: number }): Promise<IlinkUpdatesPage> {
    this.pollCount += 1;
    this.lastPollTimeoutMs = input.timeoutMs;
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
    return {
      messages: this.served.messages,
      cursor: this.served.nextCursor,
      ...(this.pollTimeoutHintMs !== undefined
        ? { timeoutMs: this.pollTimeoutHintMs }
        : {}),
    };
  }

  private commitIfAdvanced(cursor: string): void {
    if (this.served && cursor === this.served.nextCursor) {
      this.served = undefined;
    }
  }

  /** Script the QR status sequence; the last entry repeats when exhausted. */
  scriptQrStatuses(statuses: IlinkQrStatus[]): void {
    this.qrScript = [...statuses];
  }

  async getBotQrcode(input: { localTokenList: string[] }): Promise<IlinkQrSession> {
    this.qrSessionCount += 1;
    this.lastLocalTokenList = [...input.localTokenList];
    return { qrcode: `fake-qr-${this.qrSessionCount}`, qrContent: `ilink://fake-qr-${this.qrSessionCount}` };
  }

  async getQrcodeStatus(): Promise<IlinkQrStatus> {
    this.qrStatusCount += 1;
    const next = this.qrScript.length > 1 ? this.qrScript.shift()! : this.qrScript[0];
    return next ?? { status: 'wait' };
  }

  async sendMessage(message: IlinkSendMessage): Promise<void> {
    if (this.holdSend) {
      this.holdSend = false;
      await new Promise<void>((resolve) => this.sendWaiters.push(resolve));
    }
    if (this.failSend) {
      const error = this.failSend;
      this.failSend = undefined;
      throw error;
    }
    this.sent.push(message);
  }

  async getConfig(input: IlinkGetConfigInput): Promise<IlinkAccountConfig> {
    this.configCalls.push(input);
    return { typingTicket: `fake-ticket-${input.ilinkUserId}` };
  }

  async sendTyping(input: IlinkSendTypingInput): Promise<void> {
    this.typing.push(input);
  }

  async notifyStart(): Promise<void> {
    this.notifyStartCount += 1;
  }

  async notifyStop(): Promise<void> {
    this.notifyStopCount += 1;
  }
}
