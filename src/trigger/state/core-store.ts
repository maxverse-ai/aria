import {
  TriggerStateError,
  TRIGGER_STATE_SCHEMA_VERSION,
  type TriggerClaimInput,
  type TriggerCleanupInput,
  type TriggerDefinition,
  type TriggerDefinitionFilter,
  type TriggerFailureRecord,
  type TriggerLeaseRef,
  type TriggerMaterializationInput,
  type TriggerMaterializationResult,
  type TriggerOccurrence,
  type TriggerOccurrenceFilter,
  type TriggerRetryInput,
  type TriggerScheduleAdvanceInput,
} from './types';
import type { TriggerStateStore } from './store';
import { triggerRetryDelay } from './retry';
import {
  assertDefinitionTransition,
  assertTriggerDefinition,
  assertTriggerFailure,
  assertTriggerOccurrence,
} from './validation';

export interface TriggerStateSnapshot {
  definitions: Record<string, TriggerDefinition>;
  occurrences: Record<string, TriggerOccurrence>;
  occurrenceKeys: Record<string, string>;
}

export const EMPTY_TRIGGER_STATE: TriggerStateSnapshot = {
  definitions: {}, occurrences: {}, occurrenceKeys: {},
};

export abstract class AbstractTriggerStateStore implements TriggerStateStore {
  protected abstract read<T>(select: (state: TriggerStateSnapshot) => T): Promise<T>;
  protected abstract mutate<T>(update: (state: TriggerStateSnapshot) => T): Promise<T>;

  async createDefinition(definition: TriggerDefinition): Promise<TriggerDefinition> {
    assertTriggerDefinition(definition);
    return this.mutate((state) => {
      if (state.definitions[definition.id]) conflict(`trigger definition already exists: ${definition.id}`);
      state.definitions[definition.id] = clone(definition);
      return clone(definition);
    });
  }

  async getDefinition(id: string): Promise<TriggerDefinition | undefined> {
    return this.read((state) => cloneOptional(state.definitions[id]));
  }

  async listDefinitions(filter: TriggerDefinitionFilter = {}): Promise<readonly TriggerDefinition[]> {
    return this.read((state) => Object.values(state.definitions)
      .filter((item) => (!filter.profileId || item.profileId === filter.profileId)
        && (!filter.state || item.state === filter.state))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(clone));
  }

  async replaceDefinition(definition: TriggerDefinition, expectedRevision: number): Promise<TriggerDefinition> {
    assertTriggerDefinition(definition);
    return this.mutate((state) => {
      const existing = requiredDefinition(state, definition.id);
      if (existing.revision !== expectedRevision || definition.revision !== expectedRevision + 1) revisionConflict();
      for (const key of ['id', 'profileId', 'providerId', 'instanceId', 'sourceKind', 'createdAt'] as const) {
        if (definition[key] !== existing[key]) conflict(`immutable definition field changed: ${key}`);
      }
      assertDefinitionTransition(existing.state, definition.state);
      state.definitions[definition.id] = clone(definition);
      return clone(definition);
    });
  }

  async materialize(input: TriggerMaterializationInput): Promise<TriggerMaterializationResult> {
    assertTriggerOccurrence(input.occurrence);
    timestamp(input.advancedAt, 'schedule advancement time');
    timestampOptional(input.nextFireAt, 'next fire time');
    return this.mutate((state) => {
      const existingId = state.occurrenceKeys[input.occurrence.idempotencyKey];
      if (existingId) {
        const duplicate = state.occurrences[existingId];
        if (!duplicate) corrupt('occurrence key points to a missing occurrence');
        return { status: 'duplicate' as const, definition: clone(requiredDefinition(state, input.definitionId)), occurrence: clone(duplicate) };
      }
      const definition = requiredDefinition(state, input.definitionId);
      if (definition.state !== 'active') conflict('only active trigger definitions may materialize occurrences');
      if (definition.revision !== input.expectedRevision) revisionConflict();
      if (input.expectedNextFireAt !== undefined && definition.nextFireAt !== input.expectedNextFireAt) revisionConflict('schedule cursor changed');
      const occurrence = input.occurrence;
      if (occurrence.definitionId !== definition.id
        || occurrence.profileId !== definition.profileId
        || occurrence.definitionRevision !== definition.revision) conflict('occurrence does not match its trigger definition');
      if (occurrence.idempotencyKey !== triggerOccurrenceIdempotencyKey(
        occurrence.profileId, occurrence.definitionId, occurrence.scheduledFor,
      )) conflict('occurrence idempotency key does not match its logical schedule identity');
      if (state.occurrences[occurrence.id]) conflict(`trigger occurrence already exists: ${occurrence.id}`);
      const advanced = { ...definition, nextFireAt: input.nextFireAt, scheduleAdvancedAt: input.advancedAt };
      assertTriggerDefinition(advanced);
      state.definitions[definition.id] = advanced;
      state.occurrences[occurrence.id] = clone(occurrence);
      state.occurrenceKeys[occurrence.idempotencyKey] = occurrence.id;
      return { status: 'created' as const, definition: clone(advanced), occurrence: clone(occurrence) };
    });
  }

  async advanceSchedule(input: TriggerScheduleAdvanceInput): Promise<TriggerDefinition> {
    timestamp(input.advancedAt, 'schedule advancement time');
    timestampOptional(input.nextFireAt, 'next fire time');
    return this.mutate((state) => {
      const definition = requiredDefinition(state, input.definitionId);
      if (definition.state !== 'active') conflict('only active trigger definitions may advance schedules');
      if (definition.revision !== input.expectedRevision) revisionConflict();
      if (definition.nextFireAt !== input.expectedNextFireAt) revisionConflict('schedule cursor changed');
      const advanced = {
        ...definition,
        nextFireAt: input.nextFireAt,
        scheduleAdvancedAt: input.advancedAt,
        updatedAt: Math.max(definition.updatedAt, input.advancedAt),
      };
      assertTriggerDefinition(advanced);
      state.definitions[definition.id] = clone(advanced);
      return clone(advanced);
    });
  }

  async getOccurrence(id: string): Promise<TriggerOccurrence | undefined> {
    return this.read((state) => cloneOptional(state.occurrences[id]));
  }

  async getOccurrenceByIdempotencyKey(key: string): Promise<TriggerOccurrence | undefined> {
    return this.read((state) => {
      const id = state.occurrenceKeys[key];
      return id ? cloneOptional(state.occurrences[id]) : undefined;
    });
  }

  async listOccurrences(filter: TriggerOccurrenceFilter = {}): Promise<readonly TriggerOccurrence[]> {
    return this.read((state) => Object.values(state.occurrences)
      .filter((item) => (!filter.profileId || item.profileId === filter.profileId)
        && (!filter.definitionId || item.definitionId === filter.definitionId)
        && (!filter.state || item.state === filter.state))
      .sort((a, b) => a.scheduledFor - b.scheduledFor || a.id.localeCompare(b.id)).map(clone));
  }

  async claimNext(input: TriggerClaimInput): Promise<TriggerOccurrence | undefined> {
    assertClaim(input);
    return this.mutate((state) => {
      const candidate = Object.values(state.occurrences)
        .filter((item) => (!input.profileId || item.profileId === input.profileId) && claimable(item, input.now))
        .sort((a, b) => dueAt(a) - dueAt(b) || a.scheduledFor - b.scheduledFor || a.id.localeCompare(b.id))[0];
      if (!candidate) return undefined;
      const recovering = candidate.state === 'leased' || candidate.state === 'dispatching' || candidate.state === 'running';
      const token = candidate.fence + 1;
      const claimed: TriggerOccurrence = {
        ...candidate,
        state: recovering ? candidate.state : 'leased',
        attempt: recovering ? candidate.attempt : candidate.attempt + 1,
        fence: token,
        nextAttemptAt: undefined,
        lease: {
          leaseId: input.leaseId,
          owner: input.leaseOwner,
          token,
          acquiredAt: input.now,
          expiresAt: input.now + input.leaseDurationMs,
        },
        updatedAt: input.now,
      };
      assertTriggerOccurrence(claimed);
      state.occurrences[claimed.id] = claimed;
      return clone(claimed);
    });
  }

  async renewLease(id: string, lease: TriggerLeaseRef, now: number, expiresAt: number): Promise<TriggerOccurrence> {
    timestamp(now, 'lease renewal time'); timestamp(expiresAt, 'lease expiry time');
    if (expiresAt <= now) conflict('renewed lease must expire after now');
    return this.withLease(id, lease, now, (record) => ({ ...record, lease: { ...record.lease!, expiresAt }, updatedAt: now }));
  }

  async beginDispatch(id: string, lease: TriggerLeaseRef, intentId: string, at: number): Promise<TriggerOccurrence> {
    nonEmpty(intentId, 'intent id'); timestamp(at, 'dispatch time');
    return this.withLease(id, lease, at, (record) => {
      if (record.state !== 'leased' && record.state !== 'dispatching') transition(record.state, 'dispatching');
      if (record.dispatch && record.dispatch.intentId !== intentId) conflict('dispatch checkpoint already has a different intent id');
      return { ...record, state: 'dispatching', dispatch: record.dispatch ?? { intentId, persistedAt: at }, updatedAt: at };
    });
  }

  async markRunning(id: string, lease: TriggerLeaseRef, runId: string, at: number): Promise<TriggerOccurrence> {
    nonEmpty(runId, 'run id'); timestamp(at, 'run submission time');
    return this.withLease(id, lease, at, (record) => {
      if (record.state !== 'dispatching' || !record.dispatch) transition(record.state, 'running');
      if (record.dispatch.runId && record.dispatch.runId !== runId) conflict('dispatch checkpoint already has a different run id');
      return { ...record, state: 'running', dispatch: { ...record.dispatch, runId, submittedAt: record.dispatch.submittedAt ?? at }, updatedAt: at };
    });
  }

  async markSucceeded(id: string, lease: TriggerLeaseRef, at: number): Promise<TriggerOccurrence> {
    timestamp(at, 'completion time');
    return this.withLease(id, lease, at, (record) => {
      if (record.state !== 'running') transition(record.state, 'succeeded');
      return clearLease({ ...record, state: 'succeeded', failure: undefined, blockedCode: undefined, completedAt: at, updatedAt: at });
    });
  }

  async markSkipped(id: string, lease: TriggerLeaseRef, code: string, at: number): Promise<TriggerOccurrence> {
    stableCode(code); timestamp(at, 'skip time');
    return this.withLease(id, lease, at, (record) => {
      if (record.state !== 'leased' && record.state !== 'dispatching') transition(record.state, 'skipped');
      return clearLease({
        ...record,
        state: 'skipped',
        blockedCode: code,
        failure: undefined,
        completedAt: at,
        updatedAt: at,
      });
    });
  }

  async scheduleRetry(input: TriggerRetryInput): Promise<TriggerOccurrence> {
    timestamp(input.now, 'retry time'); assertTriggerFailure(input.failure);
    return this.withLease(input.occurrenceId, input.lease, input.now, (record, definition) => {
      if (!['leased', 'dispatching', 'running'].includes(record.state)) transition(record.state, 'retry-wait');
      if (input.failure.kind !== 'transient') conflict('only transient failures may be scheduled for automatic retry');
      if (record.attempt >= definition.retryPolicy.maxAttempts) {
        return clearLease({ ...record, state: 'dead', failure: clone(input.failure), completedAt: input.now, updatedAt: input.now });
      }
      const delay = triggerRetryDelay(record.id, record.attempt, definition.retryPolicy, input.retryAfterMs);
      return clearLease({
        ...record,
        state: 'retry-wait',
        failure: clone(input.failure),
        nextAttemptAt: input.now + delay,
        dispatch: input.preserveDispatch ? record.dispatch : undefined,
        updatedAt: input.now,
      });
    });
  }

  async markDeferred(id: string, lease: TriggerLeaseRef, blockedCode: string, at: number): Promise<TriggerOccurrence> {
    stableCode(blockedCode); timestamp(at, 'deferred time');
    return this.withLease(id, lease, at, (record) => {
      if (!['leased', 'dispatching'].includes(record.state)) transition(record.state, 'deferred');
      return clearLease({ ...record, state: 'deferred', blockedCode, updatedAt: at });
    });
  }

  async resumeDeferred(id: string, at: number): Promise<TriggerOccurrence> {
    timestamp(at, 'resume time');
    return this.mutate((state) => {
      const record = requiredOccurrence(state, id);
      if (record.state !== 'deferred') transition(record.state, 'pending');
      const updated = { ...record, state: 'pending' as const, blockedCode: undefined, failure: undefined, updatedAt: at };
      assertTriggerOccurrence(updated); state.occurrences[id] = updated; return clone(updated);
    });
  }

  async markDead(id: string, lease: TriggerLeaseRef, failure: TriggerFailureRecord, at: number): Promise<TriggerOccurrence> {
    assertTriggerFailure(failure); timestamp(at, 'dead time');
    return this.withLease(id, lease, at, (record) => clearLease({
      ...record, state: 'dead', failure: clone(failure), completedAt: at, updatedAt: at,
    }));
  }

  async retryDead(id: string, at: number): Promise<TriggerOccurrence> {
    timestamp(at, 'manual retry time');
    return this.mutate((state) => {
      const record = requiredOccurrence(state, id);
      if (record.state !== 'dead') transition(record.state, 'pending');
      const updated: TriggerOccurrence = {
        ...record, state: 'pending', failure: undefined, completedAt: undefined,
        deadAcknowledgedAt: undefined, nextAttemptAt: at, dispatch: undefined, updatedAt: at,
      };
      assertTriggerOccurrence(updated); state.occurrences[id] = updated; return clone(updated);
    });
  }

  async acknowledgeDead(id: string, at: number): Promise<TriggerOccurrence> {
    timestamp(at, 'dead acknowledgement time');
    return this.mutate((state) => {
      const record = requiredOccurrence(state, id);
      if (record.state !== 'dead') conflict('only dead occurrences may be acknowledged');
      const updated = { ...record, deadAcknowledgedAt: record.deadAcknowledgedAt ?? at, updatedAt: at };
      assertTriggerOccurrence(updated); state.occurrences[id] = updated; return clone(updated);
    });
  }

  async cleanup(input: TriggerCleanupInput): Promise<readonly string[]> {
    timestamp(input.completedBefore, 'cleanup threshold');
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) conflict('cleanup limit must be between 1 and 10000');
    return this.mutate((state) => {
      const removed = Object.values(state.occurrences)
        .filter((item) => item.completedAt !== undefined && item.completedAt < input.completedBefore
          && (item.state === 'succeeded' || item.state === 'skipped'
            || (item.state === 'dead' && item.deadAcknowledgedAt !== undefined)))
        .sort((a, b) => a.completedAt! - b.completedAt! || a.id.localeCompare(b.id)).slice(0, input.limit);
      for (const item of removed) { delete state.occurrences[item.id]; delete state.occurrenceKeys[item.idempotencyKey] }
      return removed.map((item) => item.id);
    });
  }

  private async withLease(
    id: string,
    lease: TriggerLeaseRef,
    at: number,
    update: (record: TriggerOccurrence, definition: TriggerDefinition) => TriggerOccurrence,
  ): Promise<TriggerOccurrence> {
    return this.mutate((state) => {
      const record = requiredOccurrence(state, id);
      if (!record.lease || record.lease.leaseId !== lease.leaseId || record.lease.token !== lease.token) {
        throw new TriggerStateError('stale or missing trigger occurrence lease', 'stale-lease');
      }
      if (record.lease.expiresAt <= at) {
        throw new TriggerStateError('trigger occurrence lease has expired', 'expired-lease');
      }
      const updated = update(record, requiredDefinition(state, record.definitionId));
      assertTriggerOccurrence(updated); state.occurrences[id] = clone(updated); return clone(updated);
    });
  }
}

export function triggerOccurrenceIdempotencyKey(profileId: string, definitionId: string, scheduledFor: number): string {
  nonEmpty(profileId, 'profile id'); nonEmpty(definitionId, 'definition id'); timestamp(scheduledFor, 'scheduled time');
  return `${profileId}\u001f${definitionId}\u001f${scheduledFor}`;
}

export function createPendingOccurrence(input: {
  id: string; profileId: string; definitionId: string; definitionRevision: number;
  scheduledFor: number; createdAt: number; metadata?: Readonly<Record<string, string>>;
}): TriggerOccurrence {
  const occurrence: TriggerOccurrence = {
    schemaVersion: TRIGGER_STATE_SCHEMA_VERSION,
    id: input.id,
    idempotencyKey: triggerOccurrenceIdempotencyKey(input.profileId, input.definitionId, input.scheduledFor),
    profileId: input.profileId,
    definitionId: input.definitionId,
    definitionRevision: input.definitionRevision,
    scheduledFor: input.scheduledFor,
    state: 'pending', attempt: 0, fence: 0,
    createdAt: input.createdAt, updatedAt: input.createdAt,
    metadata: input.metadata ?? {},
  };
  assertTriggerOccurrence(occurrence);
  return occurrence;
}

function claimable(item: TriggerOccurrence, now: number): boolean {
  if (item.state === 'pending') return (item.nextAttemptAt ?? item.scheduledFor) <= now;
  if (item.state === 'retry-wait') return item.nextAttemptAt! <= now;
  return ['leased', 'dispatching', 'running'].includes(item.state) && item.lease!.expiresAt <= now;
}
function dueAt(item: TriggerOccurrence): number { return item.nextAttemptAt ?? item.scheduledFor }
function clearLease(record: TriggerOccurrence): TriggerOccurrence { const { lease: _lease, ...rest } = record; return rest }
function requiredDefinition(state: TriggerStateSnapshot, id: string): TriggerDefinition {
  const item = state.definitions[id]; if (!item) throw new TriggerStateError(`trigger definition not found: ${id}`, 'definition-not-found'); return item;
}
function requiredOccurrence(state: TriggerStateSnapshot, id: string): TriggerOccurrence {
  const item = state.occurrences[id]; if (!item) throw new TriggerStateError(`trigger occurrence not found: ${id}`, 'occurrence-not-found'); return item;
}
function assertClaim(input: TriggerClaimInput): void {
  timestamp(input.now, 'claim time'); nonEmpty(input.leaseId, 'lease id'); nonEmpty(input.leaseOwner, 'lease owner');
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) conflict('lease duration must be positive');
}
function stableCode(value: string): void { if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) || value.length > 128) conflict('invalid stable code') }
function nonEmpty(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !value.trim()) conflict(`${label} is required`) }
function timestamp(value: unknown, label: string): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) conflict(`${label} must be a timestamp`) }
function timestampOptional(value: unknown, label: string): void { if (value !== undefined) timestamp(value, label) }
function transition(from: string, to: string): never { throw new TriggerStateError(`invalid occurrence transition: ${from} -> ${to}`, 'invalid-occurrence-transition') }
function revisionConflict(detail = 'definition revision changed'): never { throw new TriggerStateError(detail, 'revision-conflict') }
function conflict(message: string): never { throw new TriggerStateError(message, 'state-conflict') }
function corrupt(message: string): never { throw new TriggerStateError(message, 'corrupt-trigger-state') }
function clone<T>(value: T): T { return structuredClone(value) }
function cloneOptional<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : clone(value) }
