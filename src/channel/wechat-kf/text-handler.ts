import { createHash } from 'node:crypto';
import type { ProfileConversationHost } from '../../conversation/profile-host';
import {
  parseWechatKfCommand,
  renderWechatKfHelp,
  WECHAT_KF_WELCOME_TEXT,
  type WechatKfCommandKind,
} from './commands';
import type { WechatKfApiClient } from './client';
import { FileWechatKfOnboardingStore } from './onboarding-store';
import type { WechatKfMessageSink } from './processor';
import { FileWechatKfReceiptStore } from './receipt-store';
import { wechatKfActorId, wechatKfScopeId } from './session';
import type { WechatKfMessage } from './types';

export interface WechatKfCommandAuditEvent {
  command: WechatKfCommandKind | 'unknown';
  scopeId: string;
  sourceMessageKey: string;
  outcome: 'success' | 'failure';
  occurredAt: string;
  interrupted?: boolean;
}

export interface WechatKfTextHandlerOptions {
  host: Pick<ProfileConversationHost, 'runText' | 'reset' | 'interrupt'>;
  api: Pick<WechatKfApiClient, 'sendText'>;
  sessionHmacSecret: string;
  onboarding: FileWechatKfOnboardingStore;
  receipts: FileWechatKfReceiptStore;
  authorized: boolean | ((message: WechatKfMessage) => boolean);
  audit?: { record(event: WechatKfCommandAuditEvent): Promise<void> };
  onWelcomeError?: (error: unknown) => void;
}

/** Deterministic wxkf text/command adapter. No command reaches the agent. */
export class WechatKfTextHandler implements WechatKfMessageSink {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly onboardingInFlight = new Map<string, Promise<void>>();

  constructor(private readonly options: WechatKfTextHandlerOptions) {
    if (!options.sessionHmacSecret) throw new Error('wxkf session HMAC secret is required');
  }

  accept(message: WechatKfMessage): Promise<void> {
    const receiptKey = messageReceiptKey(message.msgid);
    if (this.options.receipts.hasCompleted(receiptKey)) return Promise.resolve();
    const existing = this.inFlight.get(receiptKey);
    if (existing) return existing;
    const operation = this.process(message, receiptKey)
      .then(async () => {
        this.options.receipts.markCompleted(receiptKey);
        await this.options.receipts.flush();
      })
      .finally(() => {
        if (this.inFlight.get(receiptKey) === operation) this.inFlight.delete(receiptKey);
      });
    this.inFlight.set(receiptKey, operation);
    return operation;
  }

  private async process(message: WechatKfMessage, sourceMessageKey: string): Promise<void> {
    if (message.origin !== 3) return;
    if (message.msgtype !== 'text') return;
    const externalUserId = message.external_userid;
    const openKfid = message.open_kfid;
    if (!externalUserId || !openKfid || !message.text?.content) {
      throw new Error('wxkf customer text message is missing identity or content');
    }
    const actorId = wechatKfActorId(this.options.sessionHmacSecret, externalUserId);
    const scopeId = wechatKfScopeId(this.options.sessionHmacSecret, openKfid, externalUserId);
    const command = parseWechatKfCommand(message.text.content);

    if (command) {
      try {
        if (command.kind === 'help') {
          await this.runOnboardingOperation(actorId, async () => {
            await this.sendContent(message, renderWechatKfHelp(), 'help', message.msgid);
            this.options.onboarding.markIntroduced(actorId);
            await this.options.onboarding.flush();
          });
        } else if (command.kind === 'new') {
          await this.options.host.reset(scopeId);
          await this.sendContent(message, '已开启新会话，你可以开始提问。', 'new', message.msgid);
        } else if (command.kind === 'stop') {
          const interrupted = await this.options.host.interrupt(scopeId);
          await this.sendContent(
            message,
            interrupted ? '已停止当前查询。' : '当前没有正在查询的内容。',
            'stop',
            message.msgid,
          );
          await this.audit(command.kind, scopeId, sourceMessageKey, 'success', interrupted);
          return;
        } else {
          await this.sendContent(message, '不支持该命令，请发送 /help。', 'unknown', message.msgid);
        }
        await this.audit(command.kind, scopeId, sourceMessageKey, 'success');
      } catch (error) {
        await this.audit(command.kind, scopeId, sourceMessageKey, 'failure');
        throw error;
      }
      return;
    }

    await this.ensureOnboarding(message, actorId);
    const authorized = typeof this.options.authorized === 'function'
      ? this.options.authorized(message)
      : this.options.authorized;
    const result = await this.options.host.runText({
      scopeId,
      actorId,
      prompt: message.text.content,
      authorized,
      source: 'channel:wechat-kf',
      conversationKind: 'p2p',
      sourceMessageId: message.msgid,
    });
    if (!result.ok && result.code === 'run-interrupted') return;
    await this.sendContent(
      message,
      result.ok ? result.content : result.userVisible,
      'answer',
      message.msgid,
    );
  }

  private async ensureOnboarding(message: WechatKfMessage, actorId: string): Promise<void> {
    await this.runOnboardingOperation(actorId, async () => {
      if (this.options.onboarding.hasIntroduced(actorId)) return;
      try {
        await this.sendContent(message, WECHAT_KF_WELCOME_TEXT, 'welcome', actorId);
        this.options.onboarding.markIntroduced(actorId);
        await this.options.onboarding.flush();
      } catch (error) {
        this.options.onWelcomeError?.(error);
      }
    });
  }

  private runOnboardingOperation(actorId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.onboardingInFlight.get(actorId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.onboardingInFlight.get(actorId) === operation) {
          this.onboardingInFlight.delete(actorId);
        }
      });
    this.onboardingInFlight.set(actorId, operation);
    return operation;
  }

  private async sendContent(
    message: WechatKfMessage,
    content: string,
    kind: string,
    stableSource: string,
  ): Promise<void> {
    const externalUserId = message.external_userid!;
    const openKfid = message.open_kfid!;
    const chunks = splitWechatKfText(content || '暂时没有生成可发送的回答，请稍后重试。');
    for (const [index, chunk] of chunks.entries()) {
      await this.options.api.sendText({
        externalUserId,
        openKfid,
        content: chunk,
        messageId: stableOutboundMessageId(kind, stableSource, index),
      });
    }
  }

  private async audit(
    command: WechatKfCommandKind | 'unknown',
    scopeId: string,
    sourceMessageKey: string,
    outcome: 'success' | 'failure',
    interrupted?: boolean,
  ): Promise<void> {
    await this.options.audit?.record({
      command,
      scopeId,
      sourceMessageKey,
      outcome,
      occurredAt: new Date().toISOString(),
      ...(interrupted !== undefined ? { interrupted } : {}),
    });
  }
}

export function messageReceiptKey(messageId: string): string {
  if (!messageId) throw new Error('wxkf message id is required');
  return createHash('sha256').update(`wxkf-receipt:v1:${messageId}`).digest('base64url');
}

export function stableOutboundMessageId(kind: string, source: string, part = 0): string {
  return createHash('sha256')
    .update(`wxkf-outbound:v1:${kind}:${source}:${part}`)
    .digest('base64url')
    .slice(0, 32);
}

export function splitWechatKfText(content: string, maxBytes = 2048): string[] {
  if (maxBytes < 1) throw new Error('wxkf max text bytes must be positive');
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const character of content) {
    const size = Buffer.byteLength(character, 'utf8');
    if (size > maxBytes) throw new Error('wxkf text character exceeds maximum byte size');
    if (bytes + size > maxBytes && chunk) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}
