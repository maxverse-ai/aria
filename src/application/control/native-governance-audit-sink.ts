import type {
  GovernanceAuditEvent,
  GovernanceAuditSink,
} from '../../runtime/governance-audit';
import { NativeAuditRecorder } from './native-audit-recorder';
import { nativeReadOpaqueId } from './native-read-identifiers';
import type { NativeAuditTarget } from './native-read-types';

/** Converts source-bound governance evidence to the content-free native model. */
export class NativeGovernanceAuditSink implements GovernanceAuditSink {
  constructor(private readonly profileId: string, private readonly recorder: NativeAuditRecorder) {}

  async record(event: GovernanceAuditEvent): Promise<void> {
    const targetKind = targetKindFor(event.action);
    const target: NativeAuditTarget = {
      resourceType: targetKind,
      ...(event.targetSourceId
        ? { resourceId: nativeReadOpaqueId(targetKind, this.profileId, event.targetSourceId) }
        : {}),
    };
    await this.recorder.record({
      eventId: event.eventId,
      action: event.action,
      occurredAt: event.occurredAt,
      actor: {
        kind: event.actorKind,
        ...(event.actorSourceId
          ? { identityId: nativeReadOpaqueId('identity', this.profileId, event.actorSourceId) }
          : {}),
      },
      target,
      outcome: event.outcome,
      redacted: true,
      ...(event.sourceRunId
        ? { runId: nativeReadOpaqueId('run', this.profileId, event.sourceRunId) }
        : {}),
      ...(event.conversationSourceId
        ? { conversationId: nativeReadOpaqueId('conversation', this.profileId, event.conversationSourceId) }
        : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
    });
  }
}

function targetKindFor(action: GovernanceAuditEvent['action']): 'policy' | 'attachment' | 'credential' {
  if (action === 'policy.decided') return 'policy';
  if (action === 'credential.accessed') return 'credential';
  return 'attachment';
}
