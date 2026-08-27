import { log } from '../core/logger';
import type { GovernanceAuditSink } from '../runtime/governance-audit';
import type { RunPolicyResult } from './run-policy';

export interface RecordRunPolicyDecisionInput {
  sink?: GovernanceAuditSink;
  policy: RunPolicyResult;
  eventId: string;
  occurredAt: string;
  actorSourceId: string;
  conversationSourceId: string;
  deniedTargetSourceId: string;
}

/** Record the evaluator's actual result without copying prompt or policy details. */
export async function recordRunPolicyDecision(input: RecordRunPolicyDecisionInput): Promise<void> {
  if (!input.sink) return;
  await input.sink.record({
    eventId: input.eventId,
    action: 'policy.decided',
    occurredAt: input.occurredAt,
    outcome: input.policy.ok ? 'success' : 'denied',
    actorKind: 'user',
    actorSourceId: input.actorSourceId,
    conversationSourceId: input.conversationSourceId,
    targetSourceId: input.policy.ok ? input.policy.policyFingerprint : input.deniedTargetSourceId,
    ...(!input.policy.ok ? { errorCode: auditErrorCode(input.policy.rejectReason.code) } : {}),
  }).catch((err) =>
    log.warn('governance', 'audit-write-failed', {
      action: 'policy.decided',
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}

function auditErrorCode(code: string): string {
  return code.toUpperCase().replaceAll('-', '_');
}
