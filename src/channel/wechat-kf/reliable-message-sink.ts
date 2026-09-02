import { createHash } from 'node:crypto';
import { ChannelPluginError } from '../plugin/errors';
import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelContent,
  type ChannelInboundEnvelope,
} from '../plugin/types';
import type { JsonValue } from '../../session/jcs';
import { ChannelReliabilityCoordinator } from '../reliability/coordinator';
import { channelReliabilityKey, reliabilityKeyFromEnvelope } from '../reliability/key';
import type {
  ChannelReliabilityKey,
  ChannelReliabilityRunResult,
  ChannelReliabilityStores,
  ChannelRetryPolicy,
} from '../reliability/types';
import { parseWechatKfCommand } from './commands';
import type { FileWechatKfMessageInbox } from './message-inbox';
import type { WechatKfMessageSink } from './processor';
import { wechatKfActorId, wechatKfScopeId } from './session';
import type { WechatKfMessage } from './types';

export const WECHAT_KF_PLUGIN_ID = 'wechat-kf' as const;
export const WECHAT_KF_DEFAULT_INSTANCE_ID = 'customer-service' as const;

type Timer = ReturnType<typeof setTimeout>;

export interface WechatKfReliableMessageSinkOptions {
  profileId: string;
  instanceId?: string;
  sessionHmacSecret: string;
  stores: ChannelReliabilityStores;
  compatibilityInbox: Pick<FileWechatKfMessageInbox, 'enqueue' | 'list' | 'remove'>;
  handler: WechatKfMessageSink;
  retryPolicy?: ChannelRetryPolicy;
  leaseMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancel?: (timer: Timer) => void;
  classifyError?: (error: unknown) => ChannelPluginError;
  onResult?: (result: ChannelReliabilityRunResult, context: WechatKfReliabilityContext) => void;
}

export interface WechatKfReliabilityContext {
  reliabilityKey: string;
  scopeId: string;
}

export interface WechatKfReliableMessageSinkSnapshot {
  acceptingInbound: boolean;
  inFlightInbound: number;
  scheduledRetries: number;
}

/**
 * Transitional bridge from the proven wxkf handler to shared reliability.
 *
 * The legacy handler remains the answer/delivery compatibility adapter while
 * the shared coordinator takes ownership of durable acceptance, leasing,
 * retry state, completion, and restart recovery. Accepted provider messages
 * are mirrored to the legacy inbox so the `off` rollback path can resume them.
 */
export class WechatKfReliableMessageSink implements WechatKfMessageSink {
  private readonly coordinator: ChannelReliabilityCoordinator;
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly cancelTimer: (timer: Timer) => void;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, Timer>();
  private readonly normalTails = new Map<string, Promise<void>>();
  private readonly controlTails = new Map<string, Promise<void>>();
  private acceptingInbound = true;
  private closed = false;

  constructor(private readonly options: WechatKfReliableMessageSinkOptions) {
    if (!options.profileId) throw new Error('wxkf reliability profileId is required');
    if (!options.sessionHmacSecret) throw new Error('wxkf session HMAC secret is required');
    this.instanceId = options.instanceId ?? WECHAT_KF_DEFAULT_INSTANCE_ID;
    this.now = options.now ?? Date.now;
    this.scheduleTimer = options.schedule ?? setTimeout;
    this.cancelTimer = options.cancel ?? clearTimeout;
    this.coordinator = new ChannelReliabilityCoordinator({
      stores: options.stores,
      retryPolicy: options.retryPolicy,
      leaseMs: options.leaseMs,
      now: this.now,
      processor: {
        process: async (envelope) => {
          try {
            await options.handler.accept(messageFromEnvelope(envelope));
          } catch (error) {
            throw options.classifyError?.(error) ?? defaultWechatKfFailure(error);
          }
          return [];
        },
      },
      deliverer: {
        deliver: async () => {
          throw new ChannelPluginError('wxkf compatibility processor emitted an outbound intent', {
            kind: 'configuration',
            code: 'invalid-wechat-kf-compatibility-intent',
          });
        },
      },
    });
  }

  async accept(message: WechatKfMessage): Promise<void> {
    if (!this.acceptingInbound || this.closed) {
      throw new ChannelPluginError('wxkf reliable message sink is draining', {
        kind: 'transient',
        code: 'wechat-kf-channel-draining',
      });
    }
    const envelope = wechatKfMessageEnvelope({
      profileId: this.options.profileId,
      instanceId: this.instanceId,
      sessionHmacSecret: this.options.sessionHmacSecret,
      message,
    });

    // Rollback safety: the prior runtime can consume this exact message file.
    await this.options.compatibilityInbox.enqueue(message);
    await this.coordinator.accept(envelope);
    this.schedule(envelope);
  }

  /** Imports legacy queued work and schedules all shared durable work. */
  async recover(): Promise<number> {
    if (this.closed) throw new Error('wxkf reliable message sink is closed');
    const legacy = await this.options.compatibilityInbox.list();
    const pending = new Map<string, ChannelInboundEnvelope>();
    for (const message of legacy) {
      const envelope = wechatKfMessageEnvelope({
        profileId: this.options.profileId,
        instanceId: this.instanceId,
        sessionHmacSecret: this.options.sessionHmacSecret,
        message,
      });
      await this.coordinator.accept(envelope);
      pending.set(channelReliabilityKey(envelope), envelope);
    }

    const records = (await this.options.stores.inbox.list()).filter((record) =>
      record.key.profileId === this.options.profileId
      && record.key.pluginId === WECHAT_KF_PLUGIN_ID
      && record.key.instanceId === this.instanceId);
    const legacyIds = new Set(legacy.map((message) => message.msgid));
    for (const record of records) {
      const message = messageFromEnvelope(record.envelope);
      if (!legacyIds.has(message.msgid)) {
        await this.options.compatibilityInbox.enqueue(message);
      }
      pending.set(channelReliabilityKey(record.envelope), record.envelope);
    }
    for (const envelope of pending.values()) this.schedule(envelope);
    return pending.size;
  }

  snapshot(): WechatKfReliableMessageSinkSnapshot {
    return {
      acceptingInbound: this.acceptingInbound && !this.closed,
      inFlightInbound: this.inFlight.size,
      scheduledRetries: this.retryTimers.size,
    };
  }

  async drain(deadlineAt: number): Promise<{ drained: boolean; remainingInbound: number }> {
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0) {
      throw new TypeError('wxkf drain deadlineAt must be a non-negative integer');
    }
    this.acceptingInbound = false;
    this.cancelRetries();
    while (this.inFlight.size > 0 && this.now() < deadlineAt) {
      await Promise.race([
        Promise.allSettled([...this.inFlight.values()]),
        new Promise<void>((resolve) => {
          const remaining = Math.max(0, deadlineAt - this.now());
          this.scheduleTimer(resolve, Math.min(remaining, 25));
        }),
      ]);
    }
    const durable = (await this.options.stores.inbox.list()).filter((record) =>
      record.key.profileId === this.options.profileId
      && record.key.pluginId === WECHAT_KF_PLUGIN_ID
      && record.key.instanceId === this.instanceId).length;
    const remainingInbound = Math.max(this.inFlight.size, durable);
    return { drained: remainingInbound === 0, remainingInbound };
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.acceptingInbound = false;
    this.closed = true;
    this.cancelRetries();
    await this.waitForIdle();
  }

  private schedule(envelope: ChannelInboundEnvelope): void {
    const key = channelReliabilityKey(envelope);
    if (this.closed || this.inFlight.has(key) || this.retryTimers.has(key)) return;
    const tails = isControlEnvelope(envelope) ? this.controlTails : this.normalTails;
    const previous = tails.get(envelope.scopeId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.run(envelope))
      .finally(() => {
        if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
        if (tails.get(envelope.scopeId) === operation) tails.delete(envelope.scopeId);
      });
    this.inFlight.set(key, operation);
    tails.set(envelope.scopeId, operation);
  }

  private async run(envelope: ChannelInboundEnvelope): Promise<void> {
    const key = reliabilityKeyFromEnvelope(envelope);
    const result = await this.coordinator.run(key);
    const context = {
      reliabilityKey: channelReliabilityKey(key),
      scopeId: envelope.scopeId,
    };
    this.options.onResult?.(result, context);
    if (result.status === 'completed') {
      await this.options.compatibilityInbox.remove(envelope.sourceMessageId);
      return;
    }
    if (result.status === 'waiting') {
      this.scheduleRetry(envelope, Math.max(0, result.nextAttemptAt - this.now()));
    } else if (result.status === 'busy') {
      this.scheduleRetry(envelope, this.options.leaseMs ?? 30_000);
    }
  }

  private scheduleRetry(envelope: ChannelInboundEnvelope, delayMs: number): void {
    if (this.closed) return;
    const key = channelReliabilityKey(envelope);
    if (this.retryTimers.has(key)) return;
    const timer = this.scheduleTimer(() => {
      this.retryTimers.delete(key);
      this.schedule(envelope);
    }, delayMs);
    this.retryTimers.set(key, timer);
  }

  private cancelRetries(): void {
    for (const timer of this.retryTimers.values()) this.cancelTimer(timer);
    this.retryTimers.clear();
  }
}

export function wechatKfMessageEnvelope(input: {
  profileId: string;
  instanceId?: string;
  sessionHmacSecret: string;
  message: WechatKfMessage;
}): ChannelInboundEnvelope {
  if (!input.profileId) throw new Error('wxkf reliability profileId is required');
  if (!input.sessionHmacSecret) throw new Error('wxkf session HMAC secret is required');
  assertWechatKfMessage(input.message);
  const message = input.message;
  const persistedMessage = serializableMessage(message);
  const actorId = message.external_userid
    ? wechatKfActorId(input.sessionHmacSecret, message.external_userid)
    : unroutableId('actor', message.msgid);
  const scopeId = message.open_kfid && message.external_userid
    ? wechatKfScopeId(input.sessionHmacSecret, message.open_kfid, message.external_userid)
    : unroutableId('scope', message.msgid);
  return {
    abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
    profileId: input.profileId,
    pluginId: WECHAT_KF_PLUGIN_ID,
    instanceId: input.instanceId ?? WECHAT_KF_DEFAULT_INSTANCE_ID,
    sourceMessageId: message.msgid,
    scopeId,
    actorId,
    conversation: 'p2p',
    occurredAt: normalizeWechatKfTimestamp(message.send_time),
    content: wechatKfContent(message),
    replyContext: {
      schema: 'aria.wechat-kf.message.v1',
      message: persistedMessage,
    },
  };
}

function messageFromEnvelope(envelope: ChannelInboundEnvelope): WechatKfMessage {
  const context = envelope.replyContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw invalidPersistedMessage();
  }
  const raw = context as Record<string, unknown>;
  if (raw.schema !== 'aria.wechat-kf.message.v1') throw invalidPersistedMessage();
  assertWechatKfMessage(raw.message);
  return raw.message;
}

function serializableMessage(message: WechatKfMessage): Record<string, JsonValue> {
  const normalized: Record<string, JsonValue> = {
    msgid: message.msgid,
    send_time: message.send_time,
    origin: message.origin,
    msgtype: message.msgtype,
    ...(message.open_kfid ? { open_kfid: message.open_kfid } : {}),
    ...(message.external_userid ? { external_userid: message.external_userid } : {}),
    ...(message.servicer_userid ? { servicer_userid: message.servicer_userid } : {}),
    ...(message.text ? { text: { ...message.text } } : {}),
    ...(message.image ? { image: { ...message.image } } : {}),
  };
  return normalized;
}

function wechatKfContent(message: WechatKfMessage): ChannelContent {
  if (message.msgtype === 'text' && message.text?.content) {
    return { kind: 'text', text: message.text.content };
  }
  if (message.msgtype === 'image' && message.image?.media_id) {
    return {
      kind: 'image',
      assetRef: message.image.media_id,
      contentType: 'application/octet-stream',
    };
  }
  return { kind: 'event', name: `wechat-kf.${message.msgtype}`, data: {} };
}

function assertWechatKfMessage(value: unknown): asserts value is WechatKfMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPersistedMessage();
  const message = value as Partial<WechatKfMessage>;
  if (!message.msgid || typeof message.msgid !== 'string'
    || !Number.isSafeInteger(message.send_time) || message.send_time! < 0
    || !Number.isSafeInteger(message.origin) || typeof message.msgtype !== 'string' || !message.msgtype) {
    throw invalidPersistedMessage();
  }
}

function normalizeWechatKfTimestamp(value: number): number {
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  if (!Number.isSafeInteger(milliseconds)) throw invalidPersistedMessage();
  return milliseconds;
}

function isControlEnvelope(envelope: ChannelInboundEnvelope): boolean {
  return envelope.content.kind === 'text' && Boolean(parseWechatKfCommand(envelope.content.text));
}

function unroutableId(kind: 'actor' | 'scope', messageId: string): string {
  const digest = createHash('sha256')
    .update(`wechat-kf:unroutable:${kind}:v1:${messageId}`)
    .digest('base64url');
  return `wechat-kf:unroutable:${kind}:${digest}`;
}

function defaultWechatKfFailure(error: unknown): ChannelPluginError {
  return new ChannelPluginError('wxkf compatibility processor failed', {
    kind: 'transient',
    code: 'unexpected-wechat-kf-error',
    cause: error,
  });
}

function invalidPersistedMessage(): ChannelPluginError {
  return new ChannelPluginError('invalid persisted wxkf message', {
    kind: 'permanent',
    code: 'invalid-wechat-kf-message',
  });
}
