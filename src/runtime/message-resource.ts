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
  conversationKind?: MessageConversationKind;
  content: {
    format: 'plain-text' | 'markdown' | 'structured' | 'unavailable';
    text?: string;
  };
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
  observe(event: MessageResourceEvent): Promise<void>;
  bind(binding: MessageSessionBinding): Promise<void>;
  remove(sourceMessageId: string, occurredAt: string): Promise<void>;
}
