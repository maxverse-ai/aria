import type { MessageAuditEvent, MessageAuditSink } from '../../runtime/message-audit';
import { NativeAuditRecorder } from './native-audit-recorder';
import { nativeReadOpaqueId } from './native-read-identifiers';

export class NativeMessageAuditSink implements MessageAuditSink {
  constructor(private readonly profileId: string, private readonly recorder: NativeAuditRecorder) {}

  async record(event: MessageAuditEvent): Promise<void> {
    await this.recorder.record({
      eventId: event.eventId,
      action: event.direction === 'inbound' ? 'message.received' : 'message.sent',
      occurredAt: event.occurredAt,
      actor: event.actorSourceId
        ? {
            kind: event.actorKind ?? (event.direction === 'inbound' ? 'unknown' : 'bot'),
            identityId: nativeReadOpaqueId('identity', this.profileId, event.actorSourceId),
          }
        : { kind: event.direction === 'inbound' ? 'unknown' : 'bot' },
      target: {
        resourceType: 'chat',
        resourceId: nativeReadOpaqueId('chat', this.profileId, event.conversationKey),
      },
      outcome: 'success',
      redacted: true,
    });
  }
}
