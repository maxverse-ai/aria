import {
  CHANNEL_PLUGIN_ABI_VERSION,
  ChannelPluginError,
  type ChannelAssetContent,
  type ChannelAuthIntent,
  type ChannelAuthReceipt,
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
import type { IlinkAssetStore } from './asset-store';
import {
  ILINK_COMMAND_EVENT,
  ILINK_HELP_TEXT,
  parseIlinkCommand,
  renderIlinkUnknownCommand,
} from './commands';
import type { WeixinIlinkConfig } from './config';
import { DEFAULT_MEDIA_MAX_BYTES, DEFAULT_POLL_TIMEOUT_MS } from './config';
import type { IlinkCredential, IlinkCredentialStore } from './credentials';
import type { IlinkCursorStore } from './cursor-store';
import {
  InMemoryDeliveryLedger,
  type IlinkDeliveryLedger,
} from './delivery-ledger';
import {
  DEFAULT_LOGIN_POLL_MS,
  DEFAULT_LOGIN_TIMEOUT_MS,
  type IlinkLoginService,
} from './login';
import {
  decryptIlinkMedia,
  encryptIlinkMedia,
  generateIlinkMediaKey,
  ILINK_ITEM_TYPE,
  ilinkMediaMd5,
  outboundCdnMedia,
  outboundMediaItem,
} from './media';
import {
  isIlinkAuthError,
  type IlinkInboundMessage,
  type IlinkMessageItem,
  type IlinkTransport,
} from './transport';

export interface WeixinIlinkRuntimeDeps {
  /** Currently usable transport, or undefined until login produces one. */
  transport?: IlinkTransport;
  /** Builds a transport for a credential produced by login. */
  transportFor?: (credential: IlinkCredential) => IlinkTransport;
  cursorStore: IlinkCursorStore;
  credentialStore?: IlinkCredentialStore;
  /** Dedupe boundary for coordinator retries; defaults to volatile memory. */
  deliveryLedger?: IlinkDeliveryLedger;
  /**
   * Media asset boundary for Stage 12A. Inbound downloads are persisted
   * here; outbound assetRefs resolve through it. Media stays disabled when
   * no store is composed.
   */
  assetStore?: IlinkAssetStore;
  loginService?: IlinkLoginService;
  onLoginQr?: (qrContent: string) => void;
  loginTimeoutMs?: number;
  loginPollMs?: number;
  now?: () => number;
  /** Poll error backoff; tests pass 0 for determinism. */
  backoffMs?: number;
}

interface IlinkReplyContext {
  contextToken: string;
  userId: string;
}

export interface WeixinIlinkLoginState {
  phase: 'idle' | 'qr' | 'authenticated' | 'reauth-required' | 'logged-out';
  qrContent?: string;
  code?: string;
}

/** Bounded media fetch attempts before a poison media message is dropped. */
const MEDIA_MAX_ATTEMPTS = 3;

const TERMINAL_QR_CODES: Record<string, string> = {
  need_verifycode: 'weixin-ilink-login-verify',
  verify_code_blocked: 'weixin-ilink-login-blocked',
  expired: 'weixin-ilink-login-expired',
  scaned_but_redirect: 'weixin-ilink-login-redirect',
  binded_redirect: 'weixin-ilink-login-redirect',
};

/**
 * One running weixin-ilink account: long-polls iLink, normalizes text
 * envelopes into core-owned durable ingress, and echoes `context_token`
 * on replies. The provider cursor advances only after ordered durable
 * acceptance of the batch it covers. Bearer material stays inside the
 * credential store and transport — never in config, plans, or logs.
 */
export class WeixinIlinkRuntime implements ChannelRuntime {
  readonly instance;
  /** Deterministic drop counter for observability and tests. */
  droppedInbound = 0;
  /** Envelopes suppressed because they were already accepted this epoch. */
  suppressedDuplicates = 0;
  /** Commands answered locally without entering durable ingress. */
  handledLocally = 0;

  private state: ChannelRuntimeState = 'starting';
  private accepting = false;
  private inFlightInbound = 0;
  private inFlightOutbound = 0;
  private updatedAt = 0;
  private cursor = '';
  private stopped = false;
  private loopDone: Promise<void> | undefined;
  private lastError: string | undefined;
  private transport: IlinkTransport | undefined;
  private pollHintMs: number | undefined;
  private readonly acceptedIds = new Set<string>();
  private readonly mediaAttempts = new Map<string, number>();
  private readonly typingTickets = new Map<string, string>();
  private loginStateValue: WeixinIlinkLoginState = { phase: 'idle' };
  private loginAbort: AbortController | undefined;
  private loginInFlight: Promise<ChannelAuthReceipt> | undefined;

  private readonly transportFor: ((credential: IlinkCredential) => IlinkTransport) | undefined;
  private readonly cursorStore: IlinkCursorStore;
  private readonly credentialStore: IlinkCredentialStore | undefined;
  private readonly deliveryLedger: IlinkDeliveryLedger;
  private readonly assetStore: IlinkAssetStore | undefined;
  private readonly loginService: IlinkLoginService | undefined;
  private readonly onLoginQr: ((qrContent: string) => void) | undefined;
  private readonly loginTimeoutMs: number;
  private readonly loginPollMs: number;
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
    this.transportFor = deps.transportFor;
    this.cursorStore = deps.cursorStore;
    this.credentialStore = deps.credentialStore;
    this.deliveryLedger = deps.deliveryLedger ?? new InMemoryDeliveryLedger();
    this.assetStore = deps.assetStore;
    this.loginService = deps.loginService;
    this.onLoginQr = deps.onLoginQr;
    this.loginTimeoutMs = deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.loginPollMs = deps.loginPollMs ?? DEFAULT_LOGIN_POLL_MS;
    this.now = deps.now ?? Date.now;
    this.backoffMs = deps.backoffMs ?? 250;
    this.updatedAt = this.now();
  }

  async start(): Promise<void> {
    this.cursor = await this.cursorStore.read();
    if (!this.transport) {
      this.state = 'reauth-required';
      this.loginStateValue = { phase: 'reauth-required' };
      this.touch();
      return;
    }
    await this.transport.notifyStart();
    this.beginPolling();
  }

  /** Provider-owned login surface for adapters that know this package. */
  loginState(): WeixinIlinkLoginState {
    return this.loginStateValue;
  }

  async login(_intent: ChannelAuthIntent): Promise<ChannelAuthReceipt> {
    this.loginInFlight ??= this.runLogin();
    try {
      return await this.loginInFlight;
    } finally {
      this.loginInFlight = undefined;
    }
  }

  async logout(_intent: ChannelAuthIntent): Promise<ChannelAuthReceipt> {
    this.loginAbort?.abort();
    if (this.loginInFlight) {
      await this.loginInFlight.catch(() => undefined);
      this.loginInFlight = undefined;
    }
    await this.stopPolling();
    if (this.transport) {
      await this.transport.notifyStop().catch(() => undefined);
      this.transport = undefined;
    }
    await this.credentialStore?.clear();
    this.state = 'reauth-required';
    this.loginStateValue = { phase: 'logged-out' };
    this.touch();
    return { status: 'logged-out' };
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
    const mediaContent = this.mediaContent(intent);
    if (intent.content.kind === 'event' || mediaContent === 'unsupported') {
      throw new ChannelPluginError('weixin-ilink cannot deliver this content kind', {
        kind: 'unsupported-capability',
        code: 'weixin-ilink-unsupported-content',
      });
    }
    if (mediaContent === 'gated') {
      throw new ChannelPluginError('weixin-ilink media capability is not enabled', {
        kind: 'unsupported-capability',
        code: 'weixin-ilink-media-disabled',
      });
    }
    if (!this.transport) {
      throw new ChannelPluginError('weixin-ilink runtime is not authenticated', {
        kind: 'authentication',
        code: 'weixin-ilink-auth',
      });
    }
    const reply = this.replyContext(intent.replyContext);
    // iLink has no provider idempotency key: the checkpointed deliveryId is
    // deduped against the package ledger so a coordinator retry after a
    // crash does not double-send.
    const recorded = await this.deliveryLedger.get(intent.deliveryId);
    if (recorded) return recorded;
    this.inFlightOutbound += 1;
    this.touch();
    try {
      if (mediaContent === 'media') {
        await this.deliverMedia(intent, reply);
      } else {
        await this.transport.sendMessage({
          toUserId: reply.userId,
          contextToken: reply.contextToken,
          text: intent.content.kind === 'text' ? intent.content.text : '',
        });
      }
      this.sendTypingBestEffort(reply.userId, reply.contextToken, 2);
      const receipt: ChannelDeliveryReceipt = {
        deliveryId: intent.deliveryId,
        status: 'sent',
        providerMessageId: `ilink:${intent.deliveryId}`,
        deliveredAt: this.now(),
      };
      try {
        await this.deliveryLedger.record(intent.deliveryId, receipt);
      } catch {
        // The core delivery ledger still records this receipt; failing the
        // package-side write only widens the retry window, never drops it.
        this.lastError = 'weixin-ilink-delivery-ledger';
        this.touch();
      }
      return receipt;
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
    this.loginAbort?.abort();
    if (this.loginInFlight) {
      await this.loginInFlight.catch(() => undefined);
      this.loginInFlight = undefined;
    }
    if (this.state !== 'reauth-required' && this.state !== 'failed') {
      this.state = 'stopped';
    }
    this.touch();
    if (this.loopDone) await this.loopDone;
    if (this.transport) {
      await this.transport.notifyStop().catch(() => undefined);
    }
    this.state = 'stopped';
    this.touch();
  }

  private async runLogin(): Promise<ChannelAuthReceipt> {
    if (this.state === 'ready') {
      return { status: 'authenticated' };
    }
    if (!this.loginService || !this.transportFor) {
      throw new ChannelPluginError('weixin-ilink login is not composed', {
        kind: 'configuration',
        code: 'weixin-ilink-login-unavailable',
      });
    }
    this.loginAbort = new AbortController();
    const signal = this.loginAbort.signal;
    try {
      const previous = await this.credentialStore?.read();
      const session = await this.loginService.getBotQrcode({
        localTokenList: previous ? [previous.botToken] : [],
      });
      this.loginStateValue = { phase: 'qr', qrContent: session.qrContent };
      this.onLoginQr?.(session.qrContent);
      const deadline = this.now() + this.loginTimeoutMs;
      while (!this.stopped && !signal.aborted && this.now() < deadline) {
        const status = await this.loginService.getQrcodeStatus({
          qrcode: session.qrcode,
        });
        if (status.status === 'confirmed') {
          if (!status.botToken || !status.ilinkBotId || !status.baseurl) {
            throw new ChannelPluginError('ilink confirmation lacked credential fields', {
              kind: 'authentication',
              code: 'weixin-ilink-auth',
            });
          }
          const credential: IlinkCredential = {
            botToken: status.botToken,
            ilinkBotId: status.ilinkBotId,
            baseurl: status.baseurl,
          };
          await this.credentialStore?.write(credential);
          this.transport = this.transportFor(credential);
          await this.transport.notifyStart();
          this.beginPolling();
          this.loginStateValue = {
            phase: 'authenticated',
            qrContent: session.qrContent,
          };
          return { status: 'authenticated' };
        }
        const terminal = TERMINAL_QR_CODES[status.status];
        if (terminal) {
          this.state = 'reauth-required';
          this.loginStateValue = { phase: 'reauth-required', code: terminal };
          this.touch();
          return { status: 'reauth-required', code: terminal };
        }
        // 'wait' | 'scaned' — keep polling.
        await this.sleep(this.loginPollMs, signal);
      }
      const code = signal.aborted || this.stopped
        ? 'weixin-ilink-login-cancelled'
        : 'weixin-ilink-login-timeout';
      this.loginStateValue = { phase: 'reauth-required', code };
      return { status: 'reauth-required', code };
    } finally {
      this.loginAbort = undefined;
    }
  }

  private beginPolling(): void {
    this.state = 'ready';
    this.accepting = true;
    this.lastError = undefined;
    this.touch();
    if (!this.loopDone) {
      const done = this.pollLoop().finally(() => {
        if (this.loopDone === done) this.loopDone = undefined;
      });
      this.loopDone = done;
    }
  }

  private async stopPolling(): Promise<void> {
    this.accepting = false;
    if (this.loopDone) {
      await this.loopDone;
      this.loopDone = undefined;
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped && this.accepting && this.transport) {
      let page;
      try {
        page = await this.transport.getUpdates({
          cursor: this.cursor,
          timeoutMs:
            this.pollHintMs ?? this.config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
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
      if (page.timeoutMs !== undefined) this.pollHintMs = page.timeoutMs;
      try {
        for (const message of page.messages) {
          await this.handleMessage(message);
        }
      } catch (error) {
        if (this.stopped) return;
        // Durable acceptance failed mid-batch: leave the cursor where it is
        // so the provider redelivers; the accepted-id set suppresses
        // re-offering the envelopes already durably accepted.
        this.lastError =
          error instanceof ChannelPluginError &&
          error.code.startsWith('weixin-ilink-media')
            ? error.code
            : 'weixin-ilink-ingress';
        this.touch();
        await this.sleep(this.backoffMs);
        continue;
      }
      try {
        await this.cursorStore.write(page.cursor);
      } catch {
        if (this.stopped) return;
        // Persist before advancing: on failure the provider redelivers the
        // batch and the accepted-id set suppresses re-offers until the
        // write succeeds.
        this.lastError = 'weixin-ilink-cursor';
        this.touch();
        await this.sleep(this.backoffMs);
        continue;
      }
      this.cursor = page.cursor;
      this.acceptedIds.clear();
      this.mediaAttempts.clear();
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
    const sourceMessageId = this.sourceMessageId(message);
    if (this.acceptedIds.has(sourceMessageId)) {
      this.suppressedDuplicates += 1;
      return;
    }
    const analysis = this.analyzeItems(message);
    if (analysis.unsupported) {
      this.droppedInbound += 1;
      return;
    }
    const text = analysis.text;
    const command = text !== undefined ? parseIlinkCommand(text) : undefined;
    if (command?.kind === 'help' || command?.kind === 'unknown') {
      // Provider-local reply: answered through the transport, never through
      // durable ingress. A send failure propagates so the batch redelivers.
      if (!this.transport) {
        this.droppedInbound += 1;
        return;
      }
      await this.transport.sendMessage({
        toUserId: from,
        contextToken: message.context_token ?? '',
        text:
          command.kind === 'help'
            ? ILINK_HELP_TEXT
            : renderIlinkUnknownCommand(command.input),
      });
      this.acceptedIds.add(sourceMessageId);
      this.handledLocally += 1;
      return;
    }
    this.inFlightInbound += 1;
    this.touch();
    let attachments: ChannelAssetContent[] = [];
    if (analysis.mediaItems.length > 0) {
      if (!this.mediaCapable()) {
        // Media capability is gated off: drop deterministically rather than
        // silently emulating the item as text.
        this.inFlightInbound -= 1;
        this.droppedInbound += 1;
        this.touch();
        return;
      }
      for (const item of analysis.mediaItems) {
        try {
          attachments.push(await this.downloadMedia(item));
        } catch (error) {
          if (this.dropMediaMessage(sourceMessageId, error)) {
            this.inFlightInbound -= 1;
            this.droppedInbound += 1;
            this.touch();
            return;
          }
          this.inFlightInbound -= 1;
          this.touch();
          // Propagate so the batch redelivers and the fetch is retried.
          throw new ChannelPluginError('ilink media download failed', {
            kind: 'transient',
            code: 'weixin-ilink-media',
            cause: error,
          });
        }
      }
    }
    if (text === undefined && attachments.length === 0) {
      this.inFlightInbound -= 1;
      this.droppedInbound += 1;
      this.touch();
      return;
    }
    const envelope: ChannelInboundEnvelope = {
      abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
      profileId: this.instance.profileId,
      pluginId: this.instance.pluginId,
      instanceId: this.instance.instanceId,
      sourceMessageId,
      scopeId: message.session_id || from,
      actorId: from,
      conversation: 'p2p',
      occurredAt: message.create_time_ms ?? this.now(),
      content: command
        ? {
            kind: 'event',
            name: ILINK_COMMAND_EVENT,
            data: { command: command.kind },
          }
        : text !== undefined
          ? { kind: 'text', text }
          : { ...(attachments[0] as ChannelAssetContent) },
      ...(attachments.length > (text !== undefined ? 0 : 1)
        ? { attachments: text !== undefined ? attachments : attachments.slice(1) }
        : {}),
      replyContext: {
        ilink: {
          contextToken: message.context_token ?? '',
          userId: from,
        },
      },
    };
    try {
      const acceptance = await this.context.ingress.accept(envelope);
      this.acceptedIds.add(sourceMessageId);
      this.mediaAttempts.delete(sourceMessageId);
      if (acceptance.status === 'accepted' && !command) {
        this.sendTypingBestEffort(from, message.context_token, 1);
      }
    } finally {
      this.inFlightInbound -= 1;
      this.touch();
    }
  }

  private isAllowed(userId: string): boolean {
    const allowlist = this.config.allowedUserIds;
    return allowlist.length > 0 && allowlist.includes(userId);
  }

  /**
   * Classifies each inbound item: text folds into the envelope text,
   * image/file items queue for CDN download, and voice/video items mark
   * the message unsupported (Stage 12 scopes media to images and files).
   * Items carrying no recognized payload are ignored, preserving the
   * text-MVP leniency for provider noise.
   */
  private analyzeItems(message: IlinkInboundMessage): {
    text: string | undefined;
    mediaItems: IlinkMessageItem[];
    unsupported: boolean;
  } {
    const parts: string[] = [];
    const mediaItems: IlinkMessageItem[] = [];
    let unsupported = false;
    for (const item of message.item_list ?? []) {
      const quote = item.ref_msg;
      if (quote) {
        const line = [quote.title?.trim(), this.itemText(quote.message_item)]
          .filter((part): part is string => Boolean(part && part.length > 0))
          .join(': ');
        if (line) parts.push(`> ${line}`);
      }
      const text = this.itemText(item);
      if (text) parts.push(text);
      // A typed item carrying only ref_msg is a quote wrapper, not media.
      const bare = !item.ref_msg;
      if (
        item.image_item ||
        item.file_item ||
        (bare && (item.type === ILINK_ITEM_TYPE.image || item.type === ILINK_ITEM_TYPE.file))
      ) {
        mediaItems.push(item);
      } else if (
        item.voice_item ||
        item.video_item ||
        (bare && (item.type === ILINK_ITEM_TYPE.voice || item.type === ILINK_ITEM_TYPE.video))
      ) {
        unsupported = true;
      }
    }
    return {
      text: parts.length > 0 ? parts.join('\n') : undefined,
      mediaItems,
      unsupported,
    };
  }

  private itemText(item: IlinkMessageItem | undefined): string | undefined {
    const text = item?.text_item?.text;
    return typeof text === 'string' && text.length > 0 ? text : undefined;
  }

  private mediaEnabled(): boolean {
    return this.config.mediaEnabled === true;
  }

  private mediaCapable(): boolean {
    return this.mediaEnabled() && this.assetStore !== undefined;
  }

  private mediaMaxBytes(): number {
    return this.config.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  }

  /**
   * Download -> AES-128-ECB decrypt -> asset store for one inbound media
   * item. Missing CDN fields and over-limit plaintext are permanent;
   * transport failures stay transient for the bounded retry path.
   */
  private async downloadMedia(item: IlinkMessageItem): Promise<ChannelAssetContent> {
    const transport = this.transport;
    const assetStore = this.assetStore;
    const kind: 'image' | 'file' =
      item.image_item || item.type === ILINK_ITEM_TYPE.image ? 'image' : 'file';
    const container = item.image_item ?? item.file_item;
    const media = container?.media;
    if (!transport || !assetStore || !media?.full_url || !media.aes_key) {
      throw new ChannelPluginError('ilink media item lacks CDN fields', {
        kind: 'permanent',
        code: 'weixin-ilink-media',
      });
    }
    const ciphertext = await transport.cdnDownload(media.full_url);
    const plaintext = decryptIlinkMedia(media.aes_key, ciphertext);
    if (plaintext.length > this.mediaMaxBytes()) {
      throw new ChannelPluginError('ilink media exceeds mediaMaxBytes', {
        kind: 'permanent',
        code: 'weixin-ilink-media-size',
      });
    }
    const filename = item.file_item?.file_name;
    const contentType = kind === 'image' ? 'image/*' : 'application/octet-stream';
    const assetRef = await assetStore.put({
      content: plaintext,
      contentType,
      ...(filename !== undefined ? { filename } : {}),
    });
    return {
      kind,
      assetRef,
      contentType,
      ...(filename !== undefined ? { filename } : {}),
      size: plaintext.length,
    };
  }

  /**
   * Bounded-retry classifier for inbound media: permanent failures and the
   * third attempt drop the message so a poison media item cannot wedge the
   * provider cursor; earlier transient failures propagate for redelivery.
   */
  private dropMediaMessage(sourceMessageId: string, error: unknown): boolean {
    const permanent =
      error instanceof ChannelPluginError && error.kind === 'permanent';
    const attempts = (this.mediaAttempts.get(sourceMessageId) ?? 0) + 1;
    if (permanent || attempts >= MEDIA_MAX_ATTEMPTS) {
      this.mediaAttempts.delete(sourceMessageId);
      this.lastError =
        error instanceof ChannelPluginError ? error.code : 'weixin-ilink-media';
      this.touch();
      return true;
    }
    this.mediaAttempts.set(sourceMessageId, attempts);
    return false;
  }

  /** Classifies outbound intent content for the media gate. */
  private mediaContent(
    intent: ChannelOutboundIntent,
  ): 'text' | 'media' | 'gated' | 'unsupported' {
    const assets: ChannelAssetContent[] = [
      ...(intent.content.kind === 'image' ||
      intent.content.kind === 'file' ||
      intent.content.kind === 'audio'
        ? [intent.content]
        : []),
      ...(intent.attachments ?? []),
    ];
    if (assets.some((asset) => asset.kind === 'audio')) return 'unsupported';
    if (assets.length === 0) return 'text';
    return this.mediaCapable() ? 'media' : 'gated';
  }

  /** Encrypt -> getuploadurl -> CDN POST -> sendmessage for media intents. */
  private async deliverMedia(
    intent: ChannelOutboundIntent,
    reply: IlinkReplyContext,
  ): Promise<void> {
    const transport = this.transport;
    const assetStore = this.assetStore;
    if (!transport || !assetStore) {
      throw new ChannelPluginError('weixin-ilink media is not composed', {
        kind: 'configuration',
        code: 'weixin-ilink-media',
      });
    }
    const assets: ChannelAssetContent[] = [
      ...(intent.content.kind === 'image' || intent.content.kind === 'file'
        ? [intent.content]
        : []),
      ...(intent.attachments ?? []),
    ];
    const items: IlinkMessageItem[] = [];
    if (intent.content.kind === 'text') {
      items.push({
        type: ILINK_ITEM_TYPE.text,
        text_item: { text: intent.content.text },
      });
    }
    for (const [index, asset] of assets.entries()) {
      if (asset.kind === 'audio') {
        throw new ChannelPluginError('weixin-ilink voice items are not supported', {
          kind: 'unsupported-capability',
          code: 'weixin-ilink-unsupported-content',
        });
      }
      const stored = await assetStore.resolve(asset.assetRef);
      if (!stored) {
        throw new ChannelPluginError('weixin-ilink cannot resolve outbound assetRef', {
          kind: 'permanent',
          code: 'weixin-ilink-asset',
        });
      }
      const plaintext = stored.content;
      if (plaintext.length > this.mediaMaxBytes()) {
        throw new ChannelPluginError('ilink media exceeds mediaMaxBytes', {
          kind: 'permanent',
          code: 'weixin-ilink-media-size',
        });
      }
      const key = generateIlinkMediaKey();
      const ciphertext = encryptIlinkMedia(key, plaintext);
      const upload = await transport.getUploadUrl({
        filekey: `${intent.deliveryId}-${index}`,
        mediaType: asset.kind === 'image' ? 1 : 3,
        toUserId: reply.userId,
        rawsize: plaintext.length,
        rawfilemd5: ilinkMediaMd5(plaintext),
        filesize: ciphertext.length,
        aeskey: key.toString('hex'),
      });
      const url = upload.uploadFullUrl ?? upload.uploadParam;
      if (!url) {
        throw new ChannelPluginError('ilink getuploadurl returned no CDN URL', {
          kind: 'transient',
          code: 'weixin-ilink-cdn',
        });
      }
      const encryptedParam = await transport.cdnUpload(url, ciphertext);
      items.push(
        outboundMediaItem(asset.kind, outboundCdnMedia(encryptedParam, key), {
          ...(stored.filename !== undefined ? { filename: stored.filename } : {}),
          md5: ilinkMediaMd5(plaintext),
          size: plaintext.length,
        }),
      );
    }
    await transport.sendMessage({
      toUserId: reply.userId,
      contextToken: reply.contextToken,
      itemList: items,
    });
  }

  private sendTypingBestEffort(
    userId: string,
    contextToken: string | undefined,
    status: 1 | 2,
  ): void {
    void this.sendTyping(userId, contextToken, status).catch(() => undefined);
  }

  /**
   * Typing is best-effort observability: getconfig yields a typing_ticket,
   * sendtyping toggles the indicator (status 1 = typing, 2 = cancel). A
   * cancel with no cached ticket is skipped — nothing was ever started.
   * Failures never block ingress acceptance or delivery.
   */
  private async sendTyping(
    userId: string,
    contextToken: string | undefined,
    status: 1 | 2,
  ): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    let ticket = this.typingTickets.get(userId);
    if (!ticket) {
      if (status === 2) return;
      const config = await transport.getConfig({
        ilinkUserId: userId,
        ...(contextToken ? { contextToken } : {}),
      });
      ticket = config.typingTicket;
      if (!ticket) return;
      this.typingTickets.set(userId, ticket);
    }
    await transport.sendTyping({ ilinkUserId: userId, typingTicket: ticket, status });
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

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  private touch(): void {
    this.updatedAt = this.now();
  }
}
