import { assertRunIntent } from '../../application/execution-intent';
import type { JsonValue } from '../../session/jcs';
import { assertScheduleSpec } from '../schedule';
import {
  TRIGGER_STATE_SCHEMA_VERSION,
  TriggerStateError,
  type RunIntentTemplate,
  type TriggerDefinition,
  type TriggerDefinitionState,
  type TriggerFailureRecord,
  type TriggerOccurrence,
  type TriggerOccurrenceState,
  type TriggerRetryPolicy,
} from './types';

const STATES = new Set<TriggerDefinitionState>(['draft', 'active', 'paused', 'canceled']);
const OCCURRENCE_STATES = new Set<TriggerOccurrenceState>([
  'pending', 'leased', 'dispatching', 'running', 'retry-wait', 'deferred', 'succeeded', 'dead',
]);
const FAILURE_KINDS = new Set(['transient', 'authorization', 'configuration', 'unsupported-capability', 'canceled', 'permanent']);
const SOURCE_KINDS = new Set(['schedule', 'webhook', 'internal-event']);
const CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_LENGTH = 1024;
const MAX_SPEC_BYTES = 64 * 1024;

export function assertTriggerDefinition(value: unknown): asserts value is TriggerDefinition {
  const raw = object(value, 'trigger definition');
  exactKeys(raw, [
    'schemaVersion', 'id', 'profileId', 'providerId', 'instanceId', 'sourceKind', 'state', 'revision',
    'ownerRef', 'createdBy', 'authorizationGrantRef', 'authorizationCeiling', 'triggerSpec',
    'intentTemplate', 'retryPolicy', 'quota', 'misfirePolicy', 'overlapPolicy', 'nextFireAt',
    'createdAt', 'updatedAt', 'scheduleAdvancedAt', 'pausedAt', 'canceledAt', 'metadata',
  ], 'trigger definition');
  const definition = raw as unknown as TriggerDefinition;
  if (definition.schemaVersion !== TRIGGER_STATE_SCHEMA_VERSION) invalid('unsupported trigger definition schema version');
  id(definition.id, 'definition id');
  id(definition.profileId, 'profile id');
  id(definition.providerId, 'provider id');
  id(definition.instanceId, 'instance id');
  if (!SOURCE_KINDS.has(definition.sourceKind)) invalid('invalid trigger source kind');
  if (!STATES.has(definition.state)) invalid('invalid trigger definition state');
  positive(definition.revision, 'definition revision');
  id(definition.ownerRef, 'owner ref');
  exactKeys(object(definition.createdBy, 'creator actor'), ['kind', 'actorRef'], 'creator actor');
  id(definition.createdBy?.actorRef, 'creator actor ref');
  if (!['user', 'system', 'agent'].includes(definition.createdBy?.kind)) invalid('invalid creator actor kind');
  id(definition.authorizationGrantRef, 'authorization grant ref');
  const ceiling = object(definition.authorizationCeiling, 'authorization ceiling');
  exactKeys(ceiling, ['maxRuntimeMs', 'maxAttemptsPerOccurrence', 'allowWakeProfile', 'allowedResultRouteIds'], 'authorization ceiling');
  positive(ceiling.maxRuntimeMs, 'maximum runtime');
  positive(ceiling.maxAttemptsPerOccurrence, 'maximum attempts');
  if (typeof ceiling.allowWakeProfile !== 'boolean') invalid('allowWakeProfile must be boolean');
  stringArray(ceiling.allowedResultRouteIds, 'allowed result routes', 32);
  json(definition.triggerSpec, 'trigger spec');
  assertRunIntentTemplate(definition.intentTemplate, definition);
  assertTriggerRetryPolicy(definition.retryPolicy);
  if (definition.retryPolicy.maxAttempts > definition.authorizationCeiling.maxAttemptsPerOccurrence) {
    invalid('retry policy exceeds the authorization attempt ceiling');
  }
  const quota = object(definition.quota, 'quota');
  exactKeys(quota, ['maxActiveOccurrences', 'maxRunsPerDay'], 'quota');
  positive(quota.maxActiveOccurrences, 'maximum active occurrences');
  positive(quota.maxRunsPerDay, 'maximum daily runs');
  if (!['coalesce', 'skip', 'run-once'].includes(definition.misfirePolicy)) invalid('invalid misfire policy');
  const overlap = object(definition.overlapPolicy, 'overlap policy');
  exactKeys(overlap, overlap.kind === 'parallel' ? ['kind', 'maxParallel'] : ['kind'], 'overlap policy');
  if (!['queue-one', 'skip', 'parallel'].includes(String(overlap.kind))) invalid('invalid overlap policy');
  if (overlap.kind === 'parallel') positive(overlap.maxParallel, 'maximum parallel runs');
  timestampOptional(definition.nextFireAt, 'next fire time');
  timestamp(definition.createdAt, 'created time');
  timestamp(definition.updatedAt, 'updated time');
  timestampOptional(definition.scheduleAdvancedAt, 'schedule advancement time');
  timestampOptional(definition.pausedAt, 'paused time');
  timestampOptional(definition.canceledAt, 'canceled time');
  metadata(definition.metadata, 'definition metadata');
  if (definition.updatedAt < definition.createdAt) invalid('definition update precedes creation');
  if (definition.sourceKind === 'schedule') {
    const spec = object(definition.triggerSpec, 'schedule trigger spec');
    exactKeys(spec, ['schedule', 'timeZone'], 'schedule trigger spec');
    if (typeof spec.timeZone !== 'string') invalid('schedule trigger spec requires timeZone');
    assertScheduleSpec(spec.schedule as never, spec.timeZone);
  }
}

export function assertRunIntentTemplate(
  value: unknown,
  definition?: Pick<TriggerDefinition, 'id' | 'profileId' | 'providerId' | 'sourceKind' | 'authorizationGrantRef' | 'authorizationCeiling'>,
): asserts value is RunIntentTemplate {
  const raw = object(value, 'run intent template');
  exactKeys(raw, ['actor', 'authorizationRef', 'scopeRef', 'sessionPolicy', 'input', 'workspaceRef', 'engineRequirements', 'resultRoutes'], 'run intent template');
  const template = raw as unknown as RunIntentTemplate;
  assertRunIntent({
    contractVersion: 1,
    intentId: 'validation-intent',
    profileId: definition?.profileId ?? 'validation-profile',
    sourceKind: definition?.sourceKind ?? 'schedule',
    sourceIdentity: { providerId: definition?.providerId ?? 'validation-provider' },
    idempotencyKey: 'validation-key',
    ...template,
    correlation: { requestId: definition?.id ?? 'validation-request' },
  });
  if (definition && template.authorizationRef !== definition.authorizationGrantRef) {
    invalid('run intent template authorizationRef must match its definition grant');
  }
  if (definition) {
    const allowed = new Set(definition.authorizationCeiling.allowedResultRouteIds);
    for (const routeId of flattenRouteIds(template.resultRoutes)) {
      if (!allowed.has(routeId)) invalid(`result route exceeds authorization ceiling: ${routeId}`);
    }
  }
}

export function assertTriggerOccurrence(value: unknown): asserts value is TriggerOccurrence {
  const raw = object(value, 'trigger occurrence');
  exactKeys(raw, [
    'schemaVersion', 'id', 'idempotencyKey', 'profileId', 'definitionId', 'definitionRevision',
    'scheduledFor', 'state', 'attempt', 'fence', 'nextAttemptAt', 'lease', 'dispatch', 'failure',
    'blockedCode', 'createdAt', 'updatedAt', 'completedAt', 'deadAcknowledgedAt', 'metadata',
  ], 'trigger occurrence');
  const occurrence = raw as unknown as TriggerOccurrence;
  if (occurrence.schemaVersion !== TRIGGER_STATE_SCHEMA_VERSION) invalid('unsupported trigger occurrence schema version');
  id(occurrence.id, 'occurrence id');
  id(occurrence.idempotencyKey, 'occurrence idempotency key', 4096);
  id(occurrence.profileId, 'profile id');
  id(occurrence.definitionId, 'definition id');
  positive(occurrence.definitionRevision, 'definition revision');
  timestamp(occurrence.scheduledFor, 'scheduled time');
  if (!OCCURRENCE_STATES.has(occurrence.state)) invalid('invalid occurrence state');
  nonNegative(occurrence.attempt, 'attempt');
  nonNegative(occurrence.fence, 'fence');
  timestampOptional(occurrence.nextAttemptAt, 'next attempt time');
  timestamp(occurrence.createdAt, 'created time');
  timestamp(occurrence.updatedAt, 'updated time');
  timestampOptional(occurrence.completedAt, 'completed time');
  timestampOptional(occurrence.deadAcknowledgedAt, 'dead acknowledgement time');
  metadata(occurrence.metadata, 'occurrence metadata');
  if (occurrence.updatedAt < occurrence.createdAt) invalid('occurrence update precedes creation');
  if (occurrence.lease !== undefined) {
    exactKeys(object(occurrence.lease, 'lease'), ['leaseId', 'owner', 'token', 'acquiredAt', 'expiresAt'], 'lease');
    id(occurrence.lease.leaseId, 'lease id');
    id(occurrence.lease.owner, 'lease owner');
    positive(occurrence.lease.token, 'lease token');
    timestamp(occurrence.lease.acquiredAt, 'lease acquisition time');
    timestamp(occurrence.lease.expiresAt, 'lease expiry time');
    if (occurrence.lease.expiresAt <= occurrence.lease.acquiredAt) invalid('lease expiry must follow acquisition');
    if (occurrence.lease.token !== occurrence.fence) invalid('lease token must match occurrence fence');
  }
  const active = ['leased', 'dispatching', 'running'].includes(occurrence.state);
  if (active !== (occurrence.lease !== undefined)) invalid('active occurrence state requires exactly one lease');
  if (occurrence.dispatch !== undefined) {
    exactKeys(object(occurrence.dispatch, 'dispatch checkpoint'), ['intentId', 'persistedAt', 'submittedAt', 'runId'], 'dispatch checkpoint');
    id(occurrence.dispatch.intentId, 'dispatch intent id');
    timestamp(occurrence.dispatch.persistedAt, 'dispatch persisted time');
    timestampOptional(occurrence.dispatch.submittedAt, 'dispatch submitted time');
    if (occurrence.dispatch.runId !== undefined) id(occurrence.dispatch.runId, 'run id');
  }
  if (occurrence.failure !== undefined) assertTriggerFailure(occurrence.failure);
  if (occurrence.blockedCode !== undefined) code(occurrence.blockedCode, 'blocked code');
  if (occurrence.state === 'retry-wait' && occurrence.nextAttemptAt === undefined) invalid('retry-wait requires nextAttemptAt');
  if (occurrence.state === 'deferred' && occurrence.blockedCode === undefined) invalid('deferred occurrence requires blockedCode');
  if (occurrence.state === 'succeeded' && occurrence.completedAt === undefined) invalid('succeeded occurrence requires completedAt');
  if (occurrence.state === 'dead' && (occurrence.completedAt === undefined || occurrence.failure === undefined)) invalid('dead occurrence requires failure and completedAt');
  if (occurrence.deadAcknowledgedAt !== undefined && occurrence.state !== 'dead') invalid('only dead occurrences may be acknowledged');
}

export function assertTriggerRetryPolicy(policy: TriggerRetryPolicy): void {
  exactKeys(object(policy, 'retry policy'), ['maxAttempts', 'baseDelayMs', 'maxDelayMs', 'jitterRatio'], 'retry policy');
  positive(policy?.maxAttempts, 'retry maxAttempts');
  nonNegative(policy?.baseDelayMs, 'retry baseDelayMs');
  nonNegative(policy?.maxDelayMs, 'retry maxDelayMs');
  if (policy.maxDelayMs < policy.baseDelayMs) invalid('retry maxDelayMs must be at least baseDelayMs');
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) invalid('retry jitterRatio must be between zero and one');
}

export function assertTriggerFailure(failure: TriggerFailureRecord): void {
  exactKeys(object(failure, 'failure'), ['kind', 'code', 'recordedAt', 'metadata'], 'failure');
  if (!FAILURE_KINDS.has(failure?.kind)) invalid('invalid failure kind');
  code(failure?.code, 'failure code');
  timestamp(failure?.recordedAt, 'failure time');
  if (failure.metadata !== undefined) metadata(failure.metadata, 'failure metadata');
}

export function assertDefinitionTransition(from: TriggerDefinitionState, to: TriggerDefinitionState): void {
  const allowed = from === 'draft' ? ['draft', 'active', 'canceled']
    : from === 'active' ? ['active', 'paused', 'canceled']
      : from === 'paused' ? ['paused', 'active', 'canceled'] : ['canceled'];
  if (!allowed.includes(to)) throw new TriggerStateError(`invalid definition transition: ${from} -> ${to}`, 'invalid-definition-transition');
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, any>;
}

function json(value: unknown, label: string): asserts value is JsonValue {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value) } catch { invalid(`${label} must be JSON serializable`) }
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_SPEC_BYTES) invalid(`${label} exceeds ${MAX_SPEC_BYTES} bytes`);
}

function flattenRouteIds(routes: RunIntentTemplate['resultRoutes']): string[] {
  return routes.flatMap((route) => route.kind === 'multi'
    ? [route.routeId, ...route.routes.map((child) => child.routeId)]
    : [route.routeId]);
}

function metadata(value: unknown, label: string): void {
  const record = object(value, label);
  if (Object.keys(record).length > MAX_METADATA_ENTRIES) invalid(`${label} exceeds ${MAX_METADATA_ENTRIES} entries`);
  for (const [key, item] of Object.entries(record)) {
    id(key, `${label} key`, 128);
    if (typeof item !== 'string' || item.length > MAX_METADATA_LENGTH) invalid(`${label}.${key} must be a bounded string`);
  }
}

function stringArray(value: unknown, label: string, max: number): void {
  if (!Array.isArray(value) || value.length > max) invalid(`${label} must contain at most ${max} entries`);
  value.forEach((item, index) => id(item, `${label}[${index}]`));
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !permitted.has(key));
  if (unexpected) invalid(`${label} contains unsupported field: ${unexpected}`);
}

function id(value: unknown, label: string, max = 1024): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${label} must be a non-empty bounded string`);
}

function code(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 128 || !CODE.test(value)) invalid(`${label} must be a stable kebab-case code`);
}

function timestamp(value: unknown, label: string): asserts value is number { nonNegative(value, label) }
function timestampOptional(value: unknown, label: string): void { if (value !== undefined) timestamp(value, label) }
function positive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} must be a positive safe integer`);
}
function nonNegative(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} must be a non-negative safe integer`);
}
function invalid(message: string): never { throw new TriggerStateError(message, 'invalid-trigger-state') }
