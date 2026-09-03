import type {
  TriggerClaimInput,
  TriggerCleanupInput,
  TriggerDefinition,
  TriggerDefinitionFilter,
  TriggerFailureRecord,
  TriggerLeaseRef,
  TriggerMaterializationInput,
  TriggerMaterializationResult,
  TriggerOccurrence,
  TriggerOccurrenceFilter,
  TriggerRetryInput,
} from './types';

export interface TriggerStateStore {
  createDefinition(definition: TriggerDefinition): Promise<TriggerDefinition>;
  getDefinition(id: string): Promise<TriggerDefinition | undefined>;
  listDefinitions(filter?: TriggerDefinitionFilter): Promise<readonly TriggerDefinition[]>;
  replaceDefinition(definition: TriggerDefinition, expectedRevision: number): Promise<TriggerDefinition>;

  materialize(input: TriggerMaterializationInput): Promise<TriggerMaterializationResult>;
  getOccurrence(id: string): Promise<TriggerOccurrence | undefined>;
  getOccurrenceByIdempotencyKey(key: string): Promise<TriggerOccurrence | undefined>;
  listOccurrences(filter?: TriggerOccurrenceFilter): Promise<readonly TriggerOccurrence[]>;
  claimNext(input: TriggerClaimInput): Promise<TriggerOccurrence | undefined>;
  renewLease(id: string, lease: TriggerLeaseRef, now: number, expiresAt: number): Promise<TriggerOccurrence>;
  beginDispatch(id: string, lease: TriggerLeaseRef, intentId: string, at: number): Promise<TriggerOccurrence>;
  markRunning(id: string, lease: TriggerLeaseRef, runId: string, at: number): Promise<TriggerOccurrence>;
  markSucceeded(id: string, lease: TriggerLeaseRef, at: number): Promise<TriggerOccurrence>;
  scheduleRetry(input: TriggerRetryInput): Promise<TriggerOccurrence>;
  markDeferred(id: string, lease: TriggerLeaseRef, blockedCode: string, at: number): Promise<TriggerOccurrence>;
  resumeDeferred(id: string, at: number): Promise<TriggerOccurrence>;
  markDead(id: string, lease: TriggerLeaseRef, failure: TriggerFailureRecord, at: number): Promise<TriggerOccurrence>;
  retryDead(id: string, at: number): Promise<TriggerOccurrence>;
  acknowledgeDead(id: string, at: number): Promise<TriggerOccurrence>;
  cleanup(input: TriggerCleanupInput): Promise<readonly string[]>;
}
