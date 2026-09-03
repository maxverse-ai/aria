import type {
  EngineCapabilityRequirements,
  ResultRoute,
  RunIntentActor,
  SessionPolicy,
  ValidatedAttachmentReference,
  WorkspaceReference,
} from '../../application/execution-intent';
import type { JsonValue } from '../../session/jcs';
import type { TriggerSourceKind } from '../plugin';
import type { MisfirePolicy, OverlapPolicy } from '../schedule';

export const TRIGGER_STATE_SCHEMA_VERSION = 1 as const;

export type TriggerDefinitionState = 'draft' | 'active' | 'paused' | 'canceled';

export interface TriggerRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface TriggerAuthorizationCeiling {
  maxRuntimeMs: number;
  maxAttemptsPerOccurrence: number;
  allowWakeProfile: boolean;
  allowedResultRouteIds: readonly string[];
}

export interface TriggerQuotaPolicy {
  maxActiveOccurrences: number;
  maxRunsPerDay: number;
}

/** Static input resolved into a RunIntent at dispatch time. */
export interface RunIntentTemplate {
  actor: RunIntentActor;
  authorizationRef: string;
  scopeRef: string;
  sessionPolicy: SessionPolicy;
  input: {
    prompt: string;
    attachments: readonly ValidatedAttachmentReference[];
  };
  workspaceRef: WorkspaceReference;
  engineRequirements: EngineCapabilityRequirements;
  resultRoutes: readonly ResultRoute[];
}

export interface TriggerDefinition {
  schemaVersion: typeof TRIGGER_STATE_SCHEMA_VERSION;
  id: string;
  profileId: string;
  providerId: string;
  instanceId: string;
  sourceKind: TriggerSourceKind;
  state: TriggerDefinitionState;
  revision: number;
  ownerRef: string;
  createdBy: RunIntentActor;
  authorizationGrantRef: string;
  authorizationCeiling: TriggerAuthorizationCeiling;
  triggerSpec: JsonValue;
  intentTemplate: RunIntentTemplate;
  retryPolicy: TriggerRetryPolicy;
  quota: TriggerQuotaPolicy;
  misfirePolicy: MisfirePolicy;
  overlapPolicy: OverlapPolicy;
  nextFireAt?: number;
  createdAt: number;
  updatedAt: number;
  scheduleAdvancedAt?: number;
  pausedAt?: number;
  canceledAt?: number;
  metadata: Readonly<Record<string, string>>;
}

export type TriggerOccurrenceState =
  | 'pending'
  | 'leased'
  | 'dispatching'
  | 'running'
  | 'retry-wait'
  | 'deferred'
  | 'succeeded'
  | 'skipped'
  | 'dead';

export interface TriggerOccurrenceLease {
  leaseId: string;
  owner: string;
  token: number;
  acquiredAt: number;
  expiresAt: number;
}

export interface TriggerDispatchCheckpoint {
  intentId: string;
  persistedAt: number;
  submittedAt?: number;
  runId?: string;
}

export type TriggerFailureKind =
  | 'transient'
  | 'authorization'
  | 'configuration'
  | 'unsupported-capability'
  | 'canceled'
  | 'permanent';

export interface TriggerFailureRecord {
  kind: TriggerFailureKind;
  code: string;
  recordedAt: number;
  metadata?: Readonly<Record<string, string>>;
}

export interface TriggerOccurrence {
  schemaVersion: typeof TRIGGER_STATE_SCHEMA_VERSION;
  id: string;
  idempotencyKey: string;
  profileId: string;
  definitionId: string;
  definitionRevision: number;
  scheduledFor: number;
  state: TriggerOccurrenceState;
  attempt: number;
  fence: number;
  nextAttemptAt?: number;
  lease?: TriggerOccurrenceLease;
  dispatch?: TriggerDispatchCheckpoint;
  failure?: TriggerFailureRecord;
  blockedCode?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  deadAcknowledgedAt?: number;
  metadata: Readonly<Record<string, string>>;
}

export interface TriggerLeaseRef {
  leaseId: string;
  token: number;
}

export interface TriggerDefinitionFilter {
  profileId?: string;
  state?: TriggerDefinitionState;
}

export interface TriggerOccurrenceFilter {
  profileId?: string;
  definitionId?: string;
  state?: TriggerOccurrenceState;
}

export interface TriggerMaterializationInput {
  definitionId: string;
  expectedRevision: number;
  expectedNextFireAt?: number;
  occurrence: TriggerOccurrence;
  nextFireAt?: number;
  advancedAt: number;
}

export interface TriggerMaterializationResult {
  status: 'created' | 'duplicate';
  definition: TriggerDefinition;
  occurrence: TriggerOccurrence;
}

export interface TriggerScheduleAdvanceInput {
  definitionId: string;
  expectedRevision: number;
  expectedNextFireAt?: number;
  nextFireAt?: number;
  advancedAt: number;
}

export interface TriggerClaimInput {
  now: number;
  leaseId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  profileId?: string;
}

export interface TriggerRetryInput {
  occurrenceId: string;
  lease: TriggerLeaseRef;
  failure: TriggerFailureRecord;
  now: number;
  retryAfterMs?: number;
  preserveDispatch?: boolean;
}

export interface TriggerCleanupInput {
  completedBefore: number;
  limit: number;
}

export class TriggerStateError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'TriggerStateError';
  }
}
