import { createHash } from 'node:crypto';
import type { ProfileConversationHost } from '../../conversation/profile-host';
import {
  parseWechatKfCommand,
  renderWechatKfHelp,
  renderWechatKfWelcome,
  type WechatKfCommandKind,
  type WechatKfUserCopy,
} from './commands';
import type { WechatKfApiClient } from './client';
import {
  FileWechatKfDeliveryStore,
  type WechatKfPreparedDelivery,
} from './delivery-store';
import { FileWechatKfOnboardingStore } from './onboarding-store';
import {
  textOnlyWechatKfAnswer,
  type WechatKfAnswerComposer,
  type WechatKfAnswerPart,
  type WechatKfImageMaterializer,
} from './outbound';
import { renderWechatKfPlainText } from './plain-text-renderer';
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

export interface WechatKfProcessingFeedbackContext {
  externalUserId: string;
  openKfid: string;
  inboundMessageId: string;
}

export interface WechatKfProcessingFeedbackHandle {
  beforeFinal(): Promise<void>;
  finish(): Promise<void>;
}

export interface WechatKfProcessingFeedback {
  begin(context: WechatKfProcessingFeedbackContext): WechatKfProcessingFeedbackHandle;
}

export interface WechatKfTextHandlerOptions {
  host: Pick<ProfileConversationHost, 'runText' | 'reset' | 'interrupt'>;
  api: Pick<WechatKfApiClient, 'sendText' | 'sendImage'>;
  sessionHmacSecret: string;
  onboarding: FileWechatKfOnboardingStore;
  receipts: FileWechatKfReceiptStore;
  deliveries: FileWechatKfDeliveryStore;
  authorized: boolean | ((message: WechatKfMessage) => boolean);
  userCopy?: Readonly<WechatKfUserCopy>;
  answerComposer?: WechatKfAnswerComposer;
  imageMaterializer?: WechatKfImageMaterializer;
  processingFeedback?: WechatKfProcessingFeedback;
  audit?: { record(event: WechatKfCommandAuditEvent): Promise<void> };
  onWelcomeError?: (error: unknown) => void;
  onAnswerComposeError?: (error: unknown) => void;
  onRenderError?: (error: unknown) => void;
  now?: () => number;
}

/** Deterministic wxkf text/command adapter. No command reaches the agent. */
export class WechatKfTextHandler implements WechatKfMessageSink {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly onboardingInFlight = new Map<string, Promise<void>>();
  private readonly welcomeText: string;
  private readonly helpText: string;

  constructor(private readonly options: WechatKfTextHandlerOptions) {
    if (!options.sessionHmacSecret) throw new Error('wxkf session HMAC secret is required');
    this.welcomeText = renderWechatKfWelcome(options.userCopy);
    this.helpText = renderWechatKfHelp(options.userCopy);
  }

  accept(message: WechatKfMessage): Promise<void> {
    const receiptKey = messageReceiptKey(message.msgid);
    if (this.options.receipts.hasCompleted(receiptKey)) {
      return this.options.deliveries.remove(message.msgid);
    }
    const existing = this.inFlight.get(receiptKey);
    if (existing) return existing;
    const operation = this.process(message, receiptKey)
      .then(async () => {
        this.options.receipts.markCompleted(receiptKey);
        await this.options.receipts.flush();
        await this.options.deliveries.remove(message.msgid);
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
    const prepared = await this.options.deliveries.get(message.msgid);
    if (prepared) {
      await this.deliverPrepared(message, prepared);
      return;
    }
    const command = parseWechatKfCommand(message.text.content);

    if (command) {
      try {
        if (command.kind === 'help') {
          await this.runOnboardingOperation(actorId, async () => {
            await this.sendDurableContent(message, this.helpText, 'help');
            this.options.onboarding.markIntroduced(actorId);
            await this.options.onboarding.flush();
          });
        } else if (command.kind === 'new') {
          await this.options.host.reset(scopeId);
          await this.sendDurableContent(message, '已开启新会话，你可以开始提问。', 'new');
        } else if (command.kind === 'stop') {
          const interrupted = await this.options.host.interrupt(scopeId);
          await this.sendDurableContent(
            message,
            interrupted ? '已停止当前查询。' : '当前没有正在查询的内容。',
            'stop',
          );
          await this.audit(command.kind, scopeId, sourceMessageKey, 'success', interrupted);
          return;
        } else {
          await this.sendDurableContent(message, '不支持该命令，请发送 /help。', 'unknown');
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
    const feedback = this.options.processingFeedback?.begin({
      externalUserId,
      openKfid,
      inboundMessageId: message.msgid,
    });
    try {
      const result = await this.options.host.runText({
        scopeId,
        actorId,
        prompt: message.text.content,
        authorized,
        source: 'channel:wechat-kf',
        conversationKind: 'p2p',
        sourceMessageId: message.msgid,
      });
      if (!result.ok && result.code === 'run-interrupted') {
        await feedback?.beforeFinal();
        return;
      }
      const answer = result.ok ? result.content : result.userVisible;
      const prepared = await this.prepareDurableAnswer(message, answer);
      await feedback?.beforeFinal();
      await this.deliverPrepared(message, prepared);
    } finally {
      await feedback?.finish();
    }
  }

  private async ensureOnboarding(message: WechatKfMessage, actorId: string): Promise<void> {
    await this.runOnboardingOperation(actorId, async () => {
      if (this.options.onboarding.hasIntroduced(actorId)) return;
      try {
        await this.sendBestEffortContent(message, this.welcomeText, 'welcome', actorId);
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

  private async sendDurableContent(
    message: WechatKfMessage,
    content: string,
    kind: string,
  ): Promise<void> {
    const prepared = await this.prepareDurableContent(message, content, kind);
    await this.deliverPrepared(message, prepared);
  }

  private async prepareDurableContent(
    message: WechatKfMessage,
    content: string,
    kind: string,
  ): Promise<WechatKfPreparedDelivery> {
    const rendered = this.renderContent(content);
    return this.options.deliveries.create(
      message.msgid,
      splitWechatKfText(rendered).map((chunk, index) => ({
        kind: 'text' as const,
        content: chunk,
        messageId: stableOutboundMessageId(kind, message.msgid, index),
      })),
    );
  }

  private async prepareDurableAnswer(
    message: WechatKfMessage,
    content: string,
  ): Promise<WechatKfPreparedDelivery> {
    const chunks: Array<
      | { kind: 'text'; content: string }
      | { kind: 'image'; assetRef: string }
    > = [];
    try {
      const answer: ReadonlyArray<WechatKfAnswerPart> = this.options.answerComposer
        ? await this.options.answerComposer({ content })
        : textOnlyWechatKfAnswer(content);
      if (answer.length === 0) throw new Error('wxkf answer composer returned no parts');
      for (const part of answer) {
        if (part.kind === 'image') {
          if (!this.options.imageMaterializer) {
            throw new Error('wxkf answer image materializer is unavailable');
          }
          if (!/^[^\0\r\n]{1,1024}$/.test(part.assetRef)) {
            throw new Error('invalid wxkf answer image assetRef');
          }
          chunks.push({ kind: 'image', assetRef: part.assetRef });
          continue;
        }
        for (const text of splitWechatKfText(this.renderContent(part.content))) {
          chunks.push({ kind: 'text', content: text });
        }
      }
    } catch (error) {
      if (!this.options.answerComposer) throw error;
      this.options.onAnswerComposeError?.(error);
      chunks.length = 0;
      for (const text of splitWechatKfText(this.renderContent(content))) {
        chunks.push({ kind: 'text', content: text });
      }
    }
    return this.options.deliveries.create(
      message.msgid,
      chunks.map((chunk, index) => ({
        ...chunk,
        messageId: stableOutboundMessageId('answer', message.msgid, index),
      })),
    );
  }

  private async sendBestEffortContent(
    message: WechatKfMessage,
    content: string,
    kind: string,
    stableSource: string,
  ): Promise<void> {
    const rendered = this.renderContent(content);
    for (const [index, chunk] of splitWechatKfText(rendered).entries()) {
      await this.options.api.sendText({
        externalUserId: message.external_userid!,
        openKfid: message.open_kfid!,
        content: chunk,
        messageId: stableOutboundMessageId(kind, stableSource, index),
      });
    }
  }

  private renderContent(content: string): string {
    const source = content || '暂时没有生成可发送的回答，请稍后重试。';
    let rendered: string;
    try {
      rendered = renderWechatKfPlainText(source);
    } catch (error) {
      this.options.onRenderError?.(error);
      rendered = '回答已生成，但暂时无法整理为可发送格式，请稍后重试。';
    }
    return rendered || '暂时没有生成可发送的回答，请稍后重试。';
  }

  private async deliverPrepared(
    message: WechatKfMessage,
    prepared: WechatKfPreparedDelivery,
  ): Promise<void> {
    for (const [index, chunk] of prepared.chunks.entries()) {
      if (chunk.deliveredAt !== undefined) continue;
      if (chunk.kind === 'image') {
        let mediaId = chunk.mediaId;
        const now = (this.options.now ?? Date.now)();
        if (!mediaId || (chunk.mediaExpiresAt !== undefined && chunk.mediaExpiresAt <= now)) {
          if (!this.options.imageMaterializer) {
            throw new Error('wxkf answer image materializer is unavailable');
          }
          const materialized = await this.options.imageMaterializer({ assetRef: chunk.assetRef });
          if (!/^[^\0\r\n]{1,512}$/.test(materialized.mediaId)
            || (materialized.expiresAt !== undefined
              && (!Number.isFinite(materialized.expiresAt) || materialized.expiresAt <= now))) {
            throw new Error('invalid wxkf image materialization');
          }
          await this.options.deliveries.markImageMaterialized(
            message.msgid,
            index,
            materialized,
          );
          mediaId = materialized.mediaId;
        }
        await this.options.api.sendImage({
          externalUserId: message.external_userid!,
          openKfid: message.open_kfid!,
          mediaId,
          messageId: chunk.messageId,
        });
      } else {
        await this.options.api.sendText({
          externalUserId: message.external_userid!,
          openKfid: message.open_kfid!,
          content: chunk.content,
          messageId: chunk.messageId,
        });
      }
      await this.options.deliveries.markDelivered(message.msgid, index);
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
