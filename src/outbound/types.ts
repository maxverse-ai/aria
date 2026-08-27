import type {
  CommentTarget,
  SendInput,
  SendOptions,
  StreamInput,
} from '@larksuite/channel';

/** The outbound surfaces Aria currently exposes to an optional policy. */
export type OutboundSink =
  | 'message.send'
  | 'message.stream'
  | 'card.create'
  | 'card.update'
  | 'comment.reply'
  | 'attachment.upload';

/** Why an outbound operation exists. Policies may treat control traffic separately. */
export type OutboundIntent =
  | 'unspecified'
  | 'agent.final'
  | 'agent.progress'
  | 'control.config'
  | 'control.account'
  | 'system.notice'
  | 'attachment.delivery';

export type OutboundSource = 'im' | 'card' | 'comment' | 'system';

/** Stable request context; intentionally contains identifiers, never credentials. */
export interface OutboundContext {
  profile: string;
  source: OutboundSource;
  conversationId: string;
  operationId: string;
  sourceMessageId?: string;
  senderOpenId?: string;
  runId?: string;
}

interface OutboundEnvelopeBase {
  sink: OutboundSink;
  intent: OutboundIntent;
  context: OutboundContext;
}

export interface MessageSendEnvelope extends OutboundEnvelopeBase {
  sink: 'message.send' | 'attachment.upload';
  payload: {
    to: string;
    input: SendInput;
    options?: SendOptions;
  };
}

export interface MessageStreamEnvelope extends OutboundEnvelopeBase {
  sink: 'message.stream';
  payload: {
    to: string;
    input: StreamInput;
    options?: SendOptions;
  };
}

export interface CardCreateEnvelope extends OutboundEnvelopeBase {
  sink: 'card.create';
  payload: { card: object };
}

export interface CardUpdateEnvelope extends OutboundEnvelopeBase {
  sink: 'card.update';
  payload:
    | { target: 'message'; messageId: string; card: object }
    | { target: 'card'; cardId: string; card: object; sequence: number };
}

export interface CommentReplyEnvelope extends OutboundEnvelopeBase {
  sink: 'comment.reply';
  payload: {
    target: CommentTarget;
    commentId: string;
    text: string;
    options?: { topLevel?: boolean };
  };
}

export type OutboundEnvelope =
  | MessageSendEnvelope
  | MessageStreamEnvelope
  | CardCreateEnvelope
  | CardUpdateEnvelope
  | CommentReplyEnvelope;
