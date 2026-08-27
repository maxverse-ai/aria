export type GovernanceAuditAction =
  | 'policy.decided'
  | 'attachment.read'
  | 'attachment.written'
  | 'credential.accessed';

/**
 * Content-free evidence emitted by the code path that performs the action.
 * Source identifiers exist only for sink-side hashing and must not be stored
 * verbatim by persistent implementations.
 */
export interface GovernanceAuditEvent {
  eventId: string;
  action: GovernanceAuditAction;
  occurredAt: string;
  outcome: 'success' | 'failure' | 'denied';
  actorKind: 'user' | 'bot' | 'system' | 'local-cli' | 'unknown';
  actorSourceId?: string;
  conversationSourceId?: string;
  sourceRunId?: string;
  targetSourceId?: string;
  errorCode?: string;
  latencyMs?: number;
}

export interface GovernanceAuditSink {
  record(event: GovernanceAuditEvent): Promise<void>;
}
