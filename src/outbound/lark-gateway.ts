import { randomUUID } from 'node:crypto';
import type {
  CommentSurface,
  LarkChannel,
  SendInput,
  SendOptions,
  StreamInput,
} from '@larksuite/channel';
import { activeOutboundContext, activeOutboundIntent } from './context';
import { OutboundBroker } from './broker';
import type { OutboundContext, OutboundIntent, OutboundSink } from './types';
import type { MessageAuditSink } from '../runtime/message-audit';
import type { MessageResourceSink } from '../runtime/message-resource';

export interface LarkOutboundGatewayOptions {
  profile: string;
  broker?: OutboundBroker;
  messageAudit?: MessageAuditSink;
  messageRead?: MessageResourceSink;
}
export interface LarkOutboundGateway {
  channel: LarkChannel;
  broker: OutboundBroker;
}

const ATTACHMENT_KEYS = new Set(['image', 'file', 'audio', 'video']);

export function isAttachmentSendInput(input: SendInput): boolean {
  return Object.keys(input).some((key) => ATTACHMENT_KEYS.has(key));
}

/**
 * Preserve the complete LarkChannel API while routing its six managed outbound
 * surfaces through a single broker. Read/inbound methods remain bound directly
 * to the raw channel, and the raw channel never escapes this constructor's
 * owner unless that owner deliberately keeps it (Meeting does so by design).
 */
export function createLarkOutboundGateway(
  raw: LarkChannel,
  options: LarkOutboundGatewayOptions,
): LarkOutboundGateway {
  const broker = options.broker ?? new OutboundBroker({
    ...(options.messageAudit ? { messageAudit: options.messageAudit } : {}),
    ...(options.messageRead ? { messageRead: options.messageRead } : {}),
  });
  let gateway!: LarkChannel;

  gateway = new Proxy(raw, {
    get(target, property) {
      if (property === 'send') {
        return (to: string, input: SendInput, sendOptions?: SendOptions) => {
          const attachment = isAttachmentSendInput(input);
          const sink: OutboundSink = attachment ? 'attachment.upload' : 'message.send';
          return broker.dispatch(
            {
              sink,
              intent: intentFor(sink),
              context: contextFor(options.profile, to, sendOptions?.replyTo),
              payload: {
                to,
                input,
                ...(sendOptions ? { options: sendOptions } : {}),
              },
            },
            () => target.send(to, input, sendOptions),
          );
        };
      }
      if (property === 'stream') {
        return (to: string, input: StreamInput, sendOptions?: SendOptions) =>
          broker.dispatch(
            {
              sink: 'message.stream',
              intent: intentFor('message.stream'),
              context: contextFor(options.profile, to, sendOptions?.replyTo),
              payload: {
                to,
                input,
                ...(sendOptions ? { options: sendOptions } : {}),
              },
            },
            () => target.stream(to, input, sendOptions),
          );
      }
      if (property === 'createCard') {
        return (card: object) =>
          broker.dispatch(
            {
              sink: 'card.create',
              intent: intentFor('card.create'),
              context: contextFor(options.profile, 'card'),
              payload: { card },
            },
            () => target.createCard(card),
          );
      }
      if (property === 'updateCard') {
        return (messageId: string, card: object) =>
          broker.dispatch(
            {
              sink: 'card.update',
              intent: intentFor('card.update'),
              context: contextFor(options.profile, messageId, messageId),
              payload: { target: 'message', messageId, card },
            },
            () => target.updateCard(messageId, card),
          );
      }
      if (property === 'updateCardById') {
        return (cardId: string, card: object, sequence: number) =>
          broker.dispatch(
            {
              sink: 'card.update',
              intent: intentFor('card.update'),
              context: contextFor(options.profile, cardId),
              payload: { target: 'card', cardId, card, sequence },
            },
            () => target.updateCardById(cardId, card, sequence),
          );
      }
      if (property === 'comments') {
        return createCommentGateway(target.comments, broker, options.profile);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { channel: gateway, broker };
}

function createCommentGateway(
  comments: CommentSurface,
  broker: OutboundBroker,
  profile: string,
): CommentSurface {
  return new Proxy(comments, {
    get(target, property) {
      if (property === 'reply') {
        return (
          commentTarget: Parameters<CommentSurface['reply']>[0],
          commentId: string,
          text: string,
          replyOptions?: Parameters<CommentSurface['reply']>[3],
        ) =>
          broker.dispatch(
            {
              sink: 'comment.reply',
              intent: intentFor('comment.reply'),
              context: contextFor(profile, commentId, commentId),
              payload: {
                target: commentTarget,
                commentId,
                text,
                ...(replyOptions ? { options: replyOptions } : {}),
              },
            },
            () => target.reply(commentTarget, commentId, text, replyOptions),
          );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function contextFor(profile: string, conversationId: string, sourceMessageId?: string): OutboundContext {
  const active = activeOutboundContext();
  if (active) return active;
  return {
    profile,
    source: 'system',
    conversationId,
    operationId: randomUUID(),
    ...(sourceMessageId ? { sourceMessageId } : {}),
  };
}

function intentFor(sink: OutboundSink): OutboundIntent {
  const active = activeOutboundIntent();
  if (active) return active;
  if (sink === 'message.stream') return 'agent.progress';
  if (sink === 'comment.reply') return 'agent.final';
  if (sink === 'attachment.upload') return 'attachment.delivery';
  return 'unspecified';
}
