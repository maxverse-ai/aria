import {
  CHANNEL_PLUGIN_ABI_VERSION,
  ChannelPluginError,
  type ChannelDeliveryReceipt,
  type ChannelDrainOptions,
  type ChannelDrainResult,
  type ChannelHealthSnapshot,
  type ChannelInboundEnvelope,
  type ChannelOutboundIntent,
  type ChannelPluginContext,
  type ChannelRuntime,
  type ChannelRuntimeSnapshot,
  type ChannelRuntimeState,
} from '@maxverse-ai/aria';
import type { WeixinIlinkConfig } from './config';
import { DEFAULT_POLL_TIMEOUT_MS } from './config';
import type { IlinkCursorStore } from './cursor-store';
import {
  isIlinkAuthError,
  type IlinkInboundMessage,
  type IlinkTransport,
} from './transport';

export interface WeixinIlinkRuntimeDeps {
  transport: IlinkTransport;
  cursorStore: IlinkCursorStore;
  now?: () => number;
  /** Poll error backoff; tests pass 0 for determinism. */
  backoffMs?: number;
}

interface IlinkReplyContext {
  contextToken: string;
  userId: string;
}

/**
 * One running weixin-ilink account: long-polls iLink, normalizes text
 * envelopes into core-owned durable ingress, and echoes `context_token`
 * on replies. The provider cursor advances only after ordered durable
 * acceptance of the batch it covers.
 */
export class WeixinIlinkRuntime implements ChannelRuntime {
  readonly instance;
  /** Deterministic drop counter for observability and tests. */
  droppedInbound = 0;

  private state: ChannelRuntimeState = 'starting';
  private accepting = false;
  private inFlightInbound = 0;
  private inFlightOutbound = 0;
  private updatedAt = 0;
  private cursor = '';
  private stopped = false;
  private loopDone: Promise<void> | undefined;
  private lastError: string | undefined;

  private readonly transport: IlinkTransport;
  private readonly cursorStore: IlinkCursorStore;
  private readonly now: () => number;
  private readonly backoffMs: number;
  private readonly config: WeixinIlinkConfig;
  private readonly context: ChannelPluginContext<WeixinIlinkConfig>;

  constructor(
    context: ChannelPluginContext<WeixinIlinkConfig>,
    deps: WeixinIlinkRuntimeDeps,
  ) {
    this.context = context;
    this.instance = context.instance;
    this.config = context.instance.config;
    this.transport = deps.transport;
    this.cursorStore = deps.cursorStore;
    this.now = deps.now ?? Date.now;
    this.backoffMs = deps.backoffMs ?? 250;
    this.updatedAt = this.now();
  }

  async start(): Promise<void> {
    await this.transport.notifyStart();
    this.cursor = await this.cursorStore.read();
    this.state = 'ready';
    this.accepting = true;
    this.touch();
    this.loopDone = this.pollLoop();
  }

  snapshot(): ChannelRuntimeSnapshot {
    return {
      profileId: this.instance.profileId,
      pluginId: this.instance.pluginId,
      instanceId: this.instance.instanceId,
      state: this.state,
      acceptingInbound: this.accepting,
      inFlightInbound: this.inFlightInbound,
      inFlightOutbound: this.inFlightOutbound,
      updatedAt: this.updatedAt,
    };
  }

  async health(): Promise<ChannelHealthSnapshot> {
    const status =
      this.state === 'ready'
        ? 'healthy'
        : this.state === 'reauth-required'
          ? 'reauth-required'
          : this.state === 'draining'
            ? 'degraded'
            : 'unhealthy';
    return {
      status,
      checkedAt: this.now(),
      ...(this.lastError ? { code: this.lastError } : {}),
    };
  }

  async deliver(intent: ChannelOutboundIntent): Promise<ChannelDeliveryReceipt> {
    if (this.state !== 'ready' && this.state !== 'draining') {
      throw new ChannelPluginError('weixin-ilink runtime is not delivering', {
        kind: 'transient',
        code: 'weixin-ilink-not-ready',
      });
    }
    if (intent.content.kind !== 'text') {
      throw new ChannelPluginError('weixin-ilink supports text delivery only', {
        kind: 'unsupported-capability',
        code: 'weixin-ilink-unsupported-content',
      });
    }
    const reply = this.replyContext(intent.replyContext);
    this.inFlightOutbound += 1;
    this.touch();
    try {
      await this.transport.sendMessage({
        toUserId: reply.userId,
        contextToken: reply.contextToken,
        text: intent.content.text,
      });
      return {
        deliveryId: intent.deliveryId,
        status: 'sent',
        providerMessageId: `ilink:${intent.deliveryId}`,
        deliveredAt: this.now(),
      };
    } finally {
      this.inFlightOutbound -= 1;
      this.touch();
    }
  }

  async drain(options: ChannelDrainOptions): Promise<ChannelDrainResult> {
    if (this.state === 'ready' || this.state === 'starting') {
      this.state = 'draining';
    }
    this.accepting = false;
    this.touch();
    const deadline = options.deadlineAt;
    while (this.inFlightInbound + this.inFlightOutbound > 0 && this.now() < deadline) {
      await this.sleep(Math.min(10, Math.max(1, deadline - this.now())));
    }
    const remaining = this.inFlightInbound + this.inFlightOutbound;
    return {
      drained: remaining === 0,
      remainingInbound: this.inFlightInbound,
      remainingOutbound: this.inFlightOutbound,
    };
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.accepting = false;
    if (this.state !== 'reauth-required' && this.state !== 'failed') {
      this.state = 'stopped';
    }
    this.touch();
    if (this.loopDone) await this.loopDone;
    await this.transport.notifyStop().catch(() => undefined);
    this.state = 'stopped';
    this.touch();
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped && this.accepting) {
      let page;
      try {
        page = await this.transport.getUpdates({
          cursor: this.cursor,
          timeoutMs: this.config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
        });
      } catch (error) {
        if (this.stopped) return;
        if (isIlinkAuthError(error)) {
          this.state = 'reauth-required';
          this.lastError = 'weixin-ilink-auth';
          this.accepting = false;
          this.touch();
          return;
        }
        this.lastError = 'weixin-ilink-transport';
        this.touch();
        await this.sleep(this.backoffMs);
        continue;
      }
      try {
        for (const message of page.messages) {
          await this.handleMessage(message);
        }
      } catch {
        if (this.stopped) return;
        // Durable acceptance failed mid-batch: leave the cursor where it is
        // so the provider redelivers; ingress dedupes by sourceMessageId.
        this.lastError = 'weixin-ilink-ingress';
        this.touch();
        await this.sleep(this.backoffMs);
        continue;
      }
      this.cursor = page.cursor;
      await this.cursorStore.write(page.cursor);
    }
  }

  private async handleMessage(message: IlinkInboundMessage): Promise<void> {
    const from = message.from_user_id ?? '';
    if (!from || !this.isAllowed(from)) {
      this.droppedInbound += 1;
      return;
    }
    if (message.group_id) {
      // Group conversations are a Stage 12 capability; drop deterministically.
      this.droppedInbound += 1;
      return;
    }
    const text = this.textOf(message);
    if (text === undefined) {
      this.droppedInbound += 1;
      return;
    }
    const envelope: ChannelInboundEnvelope = {
      abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
      profileId: this.instance.profileId,
      pluginId: this.instance.pluginId,
      instanceId: this.instance.instanceId,
      sourceMessageId: this.sourceMessageId(message),
      scopeId: message.session_id || from,
      actorId: from,
      conversation: 'p2p',
      occurredAt: message.create_time_ms ?? this.now(),
      content: { kind: 'text', text },
      replyContext: {
        ilink: {
          contextToken: message.context_token ?? '',
          userId: from,
        },
      },
    };
    this.inFlightInbound += 1;
    this.touch();
    try {
      await this.context.ingress.accept(envelope);
    } finally {
      this.inFlightInbound -= 1;
      this.touch();
    }
  }

  private isAllowed(userId: string): boolean {
    const allowlist = this.config.allowedUserIds;
    return allowlist.length > 0 && allowlist.includes(userId);
  }

  private textOf(message: IlinkInboundMessage): string | undefined {
    for (const item of message.item_list ?? []) {
      const text = item.text_item?.text;
      if (typeof text === 'string' && text.length > 0) return text;
    }
    return undefined;
  }

  private sourceMessageId(message: IlinkInboundMessage): string {
    if (message.message_id !== undefined) return `ilink:${message.message_id}`;
    if (message.client_id) return `ilink:${message.client_id}`;
    return `ilink:seq:${message.seq ?? 'unknown'}`;
  }

  private replyContext(raw: ChannelOutboundIntent['replyContext']): IlinkReplyContext {
    const ilink =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).ilink
        : undefined;
    const record = ilink && typeof ilink === 'object' ? (ilink as Record<string, unknown>) : undefined;
    const contextToken = record?.contextToken;
    const userId = record?.userId;
    if (typeof contextToken !== 'string' || !contextToken || typeof userId !== 'string' || !userId) {
      throw new ChannelPluginError('weixin-ilink reply requires context token and user id', {
        kind: 'configuration',
        code: 'weixin-ilink-reply-context',
      });
    }
    return { contextToken, userId };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private touch(): void {
    this.updatedAt = this.now();
  }
}
