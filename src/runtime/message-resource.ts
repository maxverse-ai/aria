export type MessageActorKind = 'user' | 'bot' | 'system' | 'unknown';
export type MessageConversationKind = 'p2p' | 'group' | 'topic';

export interface MessageResourceEvent {
  eventId: string;
  sourceMessageId: string;
  direction: 'inbound' | 'outbound';
  conversationKey: string;
  correlationId?: string;
  occurredAt: string;
  actorSourceId?: string;
  actorKind?: MessageActorKind;
  /** Channel-provided display snapshot; never used as identity or authority. */
  actorDisplayName?: string;
  conversationKind?: MessageConversationKind;
  /** Trusted channel metadata, never an authorization or a conversation key. */
  conversationName?: string;
  content: {
    format: 'plain-text' | 'markdown' | 'structured' | 'unavailable';
    text?: string;
  };
  /** Stable source identifiers; projectors convert them to provider-opaque IDs. */
  attachmentSourceIds?: readonly string[];
}

export interface MessageSessionBinding {
  bindingId: string;
  correlationId: string;
  conversationKey: string;
  conversationKind?: MessageConversationKind;
  sourceRunId: string;
  agentKind: string;
  sourceSessionId: string;
  sourceMessageIds: readonly string[];
  occurredAt: string;
}

export interface MessageResourceSink {
  /** Composition-owned capability. Space intake never uses an ambient sink. */
  readonly scope?: 'space';
  observe(event: MessageResourceEvent): Promise<void>;
  bind(binding: MessageSessionBinding): Promise<void>;
  remove(sourceMessageId: string, occurredAt: string): Promise<void>;
}
