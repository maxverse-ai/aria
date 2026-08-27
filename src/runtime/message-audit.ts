export interface MessageAuditEvent {
  eventId: string;
  direction: 'inbound' | 'outbound';
  conversationKey: string;
  occurredAt: string;
  sourceMessageId?: string;
  actorSourceId?: string;
  actorKind?: 'user' | 'bot' | 'unknown';
}

export interface MessageAuditSink {
  record(event: MessageAuditEvent): Promise<void>;
}
