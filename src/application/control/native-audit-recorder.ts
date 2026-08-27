import { nativeReadOpaqueId } from './native-read-identifiers';
import type { NativeReadRepository } from './native-read-repository';
import type {
  NativeAuditAction,
  NativeAuditActor,
  NativeAuditEventResource,
  NativeAuditTarget,
} from './native-read-types';

export interface NativeAuditRecordInput {
  /** Stable source-operation ID used only for idempotency and opaque hashing. */
  eventId: string;
  action: NativeAuditAction;
  actor: NativeAuditActor;
  outcome: NativeAuditEventResource['outcome'];
  redacted: boolean;
  occurredAt?: string;
  conversationId?: string;
  sessionId?: string;
  runId?: string;
  traceId?: string;
  target?: NativeAuditTarget;
  errorCode?: string;
  latencyMs?: number;
}

export interface NativeAuditRecorderOptions {
  profileId: string;
  repository: NativeReadRepository;
  now?: () => string;
}

/**
 * Writes explicit governance evidence at the point an action occurs.
 *
 * The input deliberately has no arbitrary metadata, transcript, prompt, tool
 * arguments/results or credential fields. Consumers must never synthesize
 * these records later by interpreting conversation text.
 */
export class NativeAuditRecorder {
  private readonly profileId: string;
  private readonly repository: NativeReadRepository;
  private readonly now: () => string;

  constructor(options: NativeAuditRecorderOptions) {
    if (!options.profileId) throw new Error('audit recorder profileId is required');
    this.profileId = options.profileId;
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async record(input: NativeAuditRecordInput): Promise<NativeAuditEventResource> {
    validate(input);
    const occurredAt = input.occurredAt ?? this.now();
    const resourceId = nativeReadOpaqueId('audit-event', this.profileId, input.eventId);
    const change = await this.repository.upsert<NativeAuditEventResource>({
      eventId: nativeReadOpaqueId('source-event', this.profileId, 'audit', input.eventId),
      changedAt: occurredAt,
      resource: {
        resourceType: 'audit-event',
        id: resourceId,
        profileId: this.profileId,
        createdAt: occurredAt,
        updatedAt: occurredAt,
        action: input.action,
        occurredAt,
        actor: input.actor,
        outcome: input.outcome,
        redacted: input.redacted,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.traceId ? { traceId: input.traceId } : {}),
        ...(input.target ? { target: input.target } : {}),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      },
    });
    if (change.resource?.resourceType !== 'audit-event') {
      throw new Error('audit repository returned an invalid resource');
    }
    return change.resource;
  }
}

function validate(input: NativeAuditRecordInput): void {
  if (!input.eventId.trim()) throw new Error('audit eventId is required');
  if (input.latencyMs !== undefined && (!Number.isFinite(input.latencyMs) || input.latencyMs < 0)) {
    throw new Error('audit latencyMs must be a non-negative finite number');
  }
  if (input.outcome !== 'failure' && input.outcome !== 'denied' && input.errorCode) {
    throw new Error('audit errorCode is only valid for failure or denied outcomes');
  }
}
