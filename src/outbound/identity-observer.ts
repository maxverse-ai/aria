import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

export interface SenderIdentityEvent {
  appId: string;
  tenantKey?: string;
  openId: string;
  userId?: string;
  unionId?: string;
}

type EmitIdentityEvent = (event: string, fields: Record<string, unknown>) => void;

const GROUP_REFRESH_MS = 30 * 60 * 1000;
const GROUP_RESOLVE_TIMEOUT_MS = 8_000;
const GROUP_RETRY_BASE_MS = 30_000;
const GROUP_RETRY_MAX_MS = 5 * 60 * 1000;

export interface GroupIdentityObserverOptions {
  resolveTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

interface GroupIdentity {
  chatId: string;
  chatType: 'group';
  chatName: string;
  ownerOpenId: string;
  ownerName: string;
}

class GroupResolutionTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`group identity lookup timed out after ${timeoutMs}ms`);
    this.name = 'GroupResolutionTimeoutError';
  }
}

/** Policy-mode audit identities, separated from message-content logging. */
export class OutboundIdentityObserver {
  private readonly observedAt = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  private readonly failureCount = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly resolveTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(
    private readonly channel: LarkChannel,
    private readonly appId: string,
    private readonly emit: EmitIdentityEvent = emitIdentityEvent,
    private readonly now: () => number = Date.now,
    options: GroupIdentityObserverOptions = {},
  ) {
    this.resolveTimeoutMs = positiveDuration(options.resolveTimeoutMs, GROUP_RESOLVE_TIMEOUT_MS);
    this.retryBaseMs = positiveDuration(options.retryBaseMs, GROUP_RETRY_BASE_MS);
    this.retryMaxMs = Math.max(
      this.retryBaseMs,
      positiveDuration(options.retryMaxMs, GROUP_RETRY_MAX_MS),
    );
  }

  observeMessage(message: NormalizedMessage): void {
    this.emit('sender-observed', { ...senderIdentityFromMessage(message, this.appId) });
    if (message.chatType !== 'p2p') this.observeGroup(message.chatId);
  }

  private observeGroup(chatId: string): void {
    const observedAt = this.observedAt.get(chatId) ?? 0;
    const now = this.now();
    if (
      now - observedAt < GROUP_REFRESH_MS ||
      now < (this.retryAt.get(chatId) ?? 0) ||
      this.inFlight.has(chatId)
    ) return;

    const attempt = (this.failureCount.get(chatId) ?? 0) + 1;
    const active = { value: true };
    this.emit('group-resolve-started', { chatId, attempt, timeoutMs: this.resolveTimeoutMs });
    const request = withTimeout(
      this.resolveGroup(chatId, active),
      this.resolveTimeoutMs,
    )
      .then((identity) => {
        this.emit('group-resolved', { ...identity });
        this.observedAt.set(chatId, this.now());
        this.retryAt.delete(chatId);
        this.failureCount.delete(chatId);
      })
      .catch((err) => {
        const failures = this.failureCount.get(chatId) ?? 0;
        const retryInMs = Math.min(this.retryBaseMs * 2 ** failures, this.retryMaxMs);
        this.failureCount.set(chatId, failures + 1);
        this.retryAt.set(chatId, this.now() + retryInMs);
        this.emit('group-resolve-failed', {
          chatId,
          attempt,
          errorCode: err instanceof GroupResolutionTimeoutError ? 'TIMEOUT' : 'LOOKUP_FAILED',
          retryInMs,
          error: safeErrorMessage(err),
        });
      })
      .finally(() => {
        active.value = false;
        if (this.inFlight.get(chatId) === request) this.inFlight.delete(chatId);
      });
    this.inFlight.set(chatId, request);
  }

  private async resolveGroup(
    chatId: string,
    active: { value: boolean },
  ): Promise<GroupIdentity> {
    const info = await this.channel.getChatInfo(chatId);
    const ownerOpenId = String(info?.ownerId ?? '').trim();
    let ownerName = '';
    if (ownerOpenId && active.value) {
      const members = await this.channel.getChatMembers(chatId, { force: true });
      ownerName = String(members.find((member) => member.id === ownerOpenId)?.name ?? '').trim();
    }
    return {
      chatId,
      chatType: 'group',
      chatName: String(info?.name ?? '').trim(),
      ownerOpenId,
      ownerName,
    };
  }
}

function emitIdentityEvent(event: string, fields: Record<string, unknown>): void {
  if (event === 'group-resolve-failed') {
    log.warn('identity', event, fields);
    return;
  }
  log.info('identity', event, fields);
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function safeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GroupResolutionTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function senderIdentityFromMessage(
  message: NormalizedMessage,
  appId: string,
): SenderIdentityEvent {
  const sender = (message.raw as {
    sender?: {
      tenant_key?: unknown;
      sender_id?: { open_id?: unknown; user_id?: unknown; union_id?: unknown };
    };
  } | undefined)?.sender;
  const stringValue = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined;
  const tenantKey = stringValue(sender?.tenant_key);
  const userId = stringValue(sender?.sender_id?.user_id);
  const unionId = stringValue(sender?.sender_id?.union_id);
  return {
    appId,
    openId: stringValue(sender?.sender_id?.open_id) ?? message.senderId,
    ...(tenantKey ? { tenantKey } : {}),
    ...(userId ? { userId } : {}),
    ...(unionId ? { unionId } : {}),
  };
}
