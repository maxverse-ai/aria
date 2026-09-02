import { createHash } from 'node:crypto';
import type {
  ProfileConversationHost,
  ProfileTextConversationResult,
} from '../../conversation/profile-host';
import {
  toPolicyAttachment,
  type NormalizedAttachment,
} from '../../media/attachment';
import type { FileAttachmentStore } from '../../media/file-store';
import type { AgentAttachment } from '../../policy/run-policy';
import {
  parseWechatKfCommand,
  type WechatKfCommandKind,
  type WechatKfUserCopy,
} from './commands';
import { WechatKfMediaError, type WechatKfApiClient } from './client';
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
import {
  assertWechatKfPresentation,
  createDefaultWechatKfPresentation,
  type WechatKfPresentation,
  type WechatKfPresentationProvider,
} from './presentation';
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
  content: string;
}

export interface WechatKfProcessingFeedbackHandle {
  beforeFinal(): Promise<void>;
  finish(): Promise<void>;
}

export interface WechatKfProcessingFeedback {
  begin(context: WechatKfProcessingFeedbackContext): WechatKfProcessingFeedbackHandle;
}

export interface WechatKfTextHandlerOptions {
  host: Pick<ProfileConversationHost, 'runText' | 'reset' | 'interrupt'> &
    Partial<Pick<ProfileConversationHost, 'run'>>;
  api: Pick<WechatKfApiClient, 'sendText' | 'sendImage'> &
    Partial<Pick<WechatKfApiClient, 'downloadImage'>>;
  attachmentStore?: Pick<FileAttachmentStore, 'persist' | 'remove'>;
  inboundImageMaxBytes?: number;
  sessionHmacSecret: string;
  onboarding: FileWechatKfOnboardingStore;
  receipts: FileWechatKfReceiptStore;
  deliveries: FileWechatKfDeliveryStore;
  authorized: boolean | ((message: WechatKfMessage) => boolean);
  userCopy?: Readonly<WechatKfUserCopy>;
  presentation?: WechatKfPresentationProvider;
  answerComposer?: WechatKfAnswerComposer;
  imageMaterializer?: WechatKfImageMaterializer;
  processingFeedback?: WechatKfProcessingFeedback;
  audit?: { record(event: WechatKfCommandAuditEvent): Promise<void> };
  onWelcomeError?: (error: unknown) => void;
  onAnswerComposeError?: (error: unknown) => void;
  onRenderError?: (error: unknown) => void;
  now?: () => number;
}

/** Deterministic wxkf text/image/command adapter. No command reaches the agent. */
export class WechatKfTextHandler implements WechatKfMessageSink {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly onboardingInFlight = new Map<string, Promise<void>>();
  private readonly presentation: WechatKfPresentationProvider;

  constructor(private readonly options: WechatKfTextHandlerOptions) {
    if (!options.sessionHmacSecret) throw new Error('wxkf session HMAC secret is required');
    if (options.presentation && options.userCopy) {
      throw new Error('wxkf presentation and legacy userCopy cannot both be configured');
    }
    const fallback = createDefaultWechatKfPresentation(options.userCopy);
    this.presentation = options.presentation ?? { resolve: () => fallback };
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
    if (message.msgtype !== 'text' && message.msgtype !== 'image') return;
    const externalUserId = message.external_userid;
    const openKfid = message.open_kfid;
    if (!externalUserId || !openKfid) {
      throw new Error('wxkf customer message is missing identity');
    }
    if (message.msgtype === 'text' && !message.text?.content) {
      throw new Error('wxkf customer text message is missing content');
    }
    if (message.msgtype === 'image' && !message.image?.media_id) {
      throw new Error('wxkf customer image message is missing media_id');
    }
    const actorId = wechatKfActorId(this.options.sessionHmacSecret, externalUserId);
    const scopeId = wechatKfScopeId(this.options.sessionHmacSecret, openKfid, externalUserId);
    const prepared = await this.options.deliveries.get(message.msgid);
    if (prepared) {
      await this.deliverPrepared(message, prepared);
      return;
    }
    const command = message.msgtype === 'text'
      ? parseWechatKfCommand(message.text!.content)
      : undefined;
    const presentation = await this.presentation.resolve({
      actorId,
      scopeId,
      message: message.msgtype === 'text'
        ? { kind: 'text', text: message.text!.content }
        : { kind: 'image' },
      ...(command ? { command: command.kind } : {}),
    });
    assertWechatKfPresentation(presentation);

    if (command) {
      try {
        if (command.kind === 'help') {
          await this.runOnboardingOperation(actorId, async () => {
            await this.sendDurableContent(message, presentation.help, 'help', presentation);
            this.options.onboarding.markIntroduced(actorId);
            await this.options.onboarding.flush();
          });
        } else if (command.kind === 'new') {
          await this.options.host.reset(scopeId);
          await this.sendDurableContent(
            message,
            presentation.newConversation,
            'new',
            presentation,
          );
        } else if (command.kind === 'stop') {
          const interrupted = await this.options.host.interrupt(scopeId);
          await this.sendDurableContent(
            message,
            interrupted ? presentation.stopped : presentation.nothingToStop,
            'stop',
            presentation,
          );
          await this.audit(command.kind, scopeId, sourceMessageKey, 'success', interrupted);
          return;
        } else {
          await this.sendDurableContent(
            message,
            presentation.unknownCommand,
            'unknown',
            presentation,
          );
        }
        await this.audit(command.kind, scopeId, sourceMessageKey, 'success');
      } catch (error) {
        await this.audit(command.kind, scopeId, sourceMessageKey, 'failure');
        throw error;
      }
      return;
    }

    await this.ensureOnboarding(message, actorId, presentation);
    const authorized = typeof this.options.authorized === 'function'
      ? this.options.authorized(message)
      : this.options.authorized;
    const feedback = this.options.processingFeedback?.begin({
      externalUserId,
      openKfid,
      inboundMessageId: message.msgid,
      content: presentation.processing,
    });
    const persistedAttachments: NormalizedAttachment[] = [];
    try {
      const attachments: AgentAttachment[] = [];
      const prompt = message.msgtype === 'text'
        ? message.text!.content
        : '请分析用户发送的图片，并直接回答与图片有关的问题。';
      if (message.msgtype === 'image') {
        if (!this.options.api.downloadImage || !this.options.attachmentStore) {
          throw new Error('wxkf inbound image capability is unavailable');
        }
        try {
          const image = await this.options.api.downloadImage({
            mediaId: message.image!.media_id,
            ...(this.options.inboundImageMaxBytes !== undefined
              ? { maxBytes: this.options.inboundImageMaxBytes }
              : {}),
          });
          const attachment = await this.options.attachmentStore.persist({
            content: image.content,
            kind: 'image',
            mime: image.contentType,
            source: 'wechat-kf',
            sourceMessageId: message.msgid,
            sourceFileKey: message.image!.media_id,
            originalName: image.filename,
          }, this.options.inboundImageMaxBytes === undefined ? {} : {
            imageMaxBytes: this.options.inboundImageMaxBytes,
            maxFileBytes: this.options.inboundImageMaxBytes,
            maxBytes: this.options.inboundImageMaxBytes,
          });
          if (attachment.decision === 'accepted') persistedAttachments.push(attachment);
          attachments.push({
            ...toPolicyAttachment(attachment),
            requiredness: 'required' as const,
          });
        } catch (error) {
          if (!(error instanceof WechatKfMediaError)) throw error;
          await this.sendDurableContent(
            message,
            error.code === 'image-too-large'
              ? presentation.imageTooLarge
              : presentation.imageInvalid,
            'image-rejected',
            presentation,
          );
          return;
        }
      }
      const conversationInput = {
        scopeId,
        actorId,
        prompt,
        authorized,
        source: 'channel:wechat-kf' as const,
        conversationKind: 'p2p' as const,
        sourceMessageId: message.msgid,
      };
      let result: ProfileTextConversationResult;
      if (this.options.host.run) {
        result = await this.options.host.run({ ...conversationInput, attachments });
      } else {
        if (attachments.length > 0) {
          throw new Error('wxkf conversation host image input is unavailable');
        }
        result = await this.options.host.runText(conversationInput);
      }
      if (!result.ok && result.code === 'run-interrupted') {
        await feedback?.beforeFinal();
        return;
      }
      const answer = result.ok ? result.content : result.userVisible;
      const prepared = await this.prepareDurableAnswer(message, answer, presentation);
      await feedback?.beforeFinal();
      await this.deliverPrepared(message, prepared);
    } finally {
      try {
        await feedback?.finish();
      } finally {
        await Promise.all(
          persistedAttachments.map((attachment) => this.options.attachmentStore!.remove(attachment)),
        );
      }
    }
  }

  private async ensureOnboarding(
    message: WechatKfMessage,
    actorId: string,
    presentation: Readonly<WechatKfPresentation>,
  ): Promise<void> {
    await this.runOnboardingOperation(actorId, async () => {
      if (this.options.onboarding.hasIntroduced(actorId)) return;
      try {
        await this.sendBestEffortContent(
          message,
          presentation.welcome,
          'welcome',
          actorId,
          presentation,
        );
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
    presentation: Readonly<WechatKfPresentation>,
  ): Promise<void> {
    const prepared = await this.prepareDurableContent(message, content, kind, presentation);
    await this.deliverPrepared(message, prepared);
  }

  private async prepareDurableContent(
    message: WechatKfMessage,
    content: string,
    kind: string,
    presentation: Readonly<WechatKfPresentation>,
  ): Promise<WechatKfPreparedDelivery> {
    const rendered = this.renderContent(content, presentation);
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
    presentation: Readonly<WechatKfPresentation>,
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
        for (const text of splitWechatKfText(this.renderContent(part.content, presentation))) {
          chunks.push({ kind: 'text', content: text });
        }
      }
    } catch (error) {
      if (!this.options.answerComposer) throw error;
      this.options.onAnswerComposeError?.(error);
      chunks.length = 0;
      for (const text of splitWechatKfText(this.renderContent(content, presentation))) {
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
    presentation: Readonly<WechatKfPresentation>,
  ): Promise<void> {
    const rendered = this.renderContent(content, presentation);
    for (const [index, chunk] of splitWechatKfText(rendered).entries()) {
      await this.options.api.sendText({
        externalUserId: message.external_userid!,
        openKfid: message.open_kfid!,
        content: chunk,
        messageId: stableOutboundMessageId(kind, stableSource, index),
      });
    }
  }

  private renderContent(
    content: string,
    presentation: Readonly<WechatKfPresentation>,
  ): string {
    const source = content || presentation.emptyAnswer;
    let rendered: string;
    try {
      rendered = renderWechatKfPlainText(source, { imageLabel: presentation.imageLabel });
    } catch (error) {
      this.options.onRenderError?.(error);
      rendered = presentation.renderFailure;
    }
    return rendered || presentation.emptyAnswer;
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
