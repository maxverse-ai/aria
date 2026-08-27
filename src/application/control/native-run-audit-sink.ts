import type { RunAuditEvent, RunAuditSink } from '../../runtime/run-executor';
import { NativeAuditRecorder } from './native-audit-recorder';
import { nativeReadOpaqueId } from './native-read-identifiers';
import type { NativeReadRepository } from './native-read-repository';
import type { NativeRunResource } from './native-read-types';

export interface NativeRunAuditSinkOptions {
  profileId: string;
  recorder: NativeAuditRecorder;
  repository: NativeReadRepository;
}

/** Converts executor-local IDs into Aria-owned opaque audit references. */
export class NativeRunAuditSink implements RunAuditSink {
  constructor(private readonly options: NativeRunAuditSinkOptions) {}

  async record(event: RunAuditEvent): Promise<void> {
    const runId = nativeReadOpaqueId('run', this.options.profileId, event.sourceRunId);
    await this.options.recorder.record({
      eventId: event.eventId,
      action: event.action,
      occurredAt: event.occurredAt,
      actor: { kind: 'system' },
      outcome: event.outcome,
      redacted: true,
      runId,
      ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    });
    if (!isRunLifecycleAction(event.action)) return;
    const existing = await this.options.repository.get<NativeRunResource>('run', runId);
    const status = runStatus(event.action);
    await this.options.repository.upsert({
      eventId: nativeReadOpaqueId('source-event', this.options.profileId, 'run', event.eventId),
      changedAt: event.occurredAt,
      resource: {
        resourceType: 'run', id: runId, profileId: this.options.profileId,
        createdAt: existing?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
        ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
        associationStatus: existing?.sessionId ? 'resolved' : 'pending',
        status,
        ...(event.action === 'run.started'
          ? { startedAt: existing?.startedAt ?? event.occurredAt }
          : existing?.startedAt ? { startedAt: existing.startedAt } : {}),
        ...(event.action !== 'run.started' ? { completedAt: event.occurredAt } : {}),
        ...(event.action !== 'run.started' ? { terminationReason: status } : {}),
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      },
    });
  }
}

type RunLifecycleAction = Extract<RunAuditEvent['action'], `run.${string}`>;

function isRunLifecycleAction(action: RunAuditEvent['action']): action is RunLifecycleAction {
  return action.startsWith('run.');
}

function runStatus(action: RunLifecycleAction): NativeRunResource['status'] {
  return action === 'run.started' ? 'running' : action.slice('run.'.length) as NativeRunResource['status'];
}
