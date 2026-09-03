import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ControlActorContext } from '../../application/control';
import type { JsonValue } from '../../session/jcs';
import { nextScheduleFire, previewSchedule, type ScheduleSpec } from '../schedule';
import {
  createPendingOccurrence,
  FileTriggerStateStore,
  TRIGGER_STATE_SCHEMA_VERSION,
  type TriggerDefinition,
  type TriggerStateStore,
} from '../state';
import { FileTriggerPlanStore } from './plan-store';
import {
  TRIGGER_MANAGEMENT_API_VERSION,
  TriggerManagementError,
  type StoredTriggerPlan,
  type TriggerApplyResult,
  type TriggerDefinitionReadModel,
  type TriggerExecuteRequest,
  type TriggerManagementCommand,
  type TriggerPlanActionRequest,
  type TriggerPlanRequest,
  type TriggerPlanResult,
  type TriggerPlanSnapshot,
  type TriggerPreviewSnapshot,
  type TriggerReadSnapshot,
} from './types';

const PLAN_TTL_MS = 15 * 60_000;

export interface TriggerManagementApiOptions {
  rootDir: string;
  store?: TriggerStateStore;
  planStore?: FileTriggerPlanStore;
  now?: () => number;
  createId?: () => string;
  onApplied?: () => Promise<void>;
  /** Internal governance adapters only. Direct agent writes fail closed by default. */
  allowAgentActor?: boolean;
}

/** Versioned application boundary shared by CLI, agent, Web and card adapters. */
export class TriggerManagementApi {
  private readonly store: TriggerStateStore;
  private readonly plans: FileTriggerPlanStore;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: TriggerManagementApiOptions) {
    this.store = options.store ?? new FileTriggerStateStore(join(options.rootDir, 'triggers', 'state.v1.json'));
    this.plans = options.planStore ?? new FileTriggerPlanStore(join(options.rootDir, 'triggers', 'plans.v1.json'));
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  async plan(request: TriggerPlanRequest): Promise<TriggerPlanResult> {
    validatePlanRequest(request);
    if (request.actor.source === 'agent' && this.options.allowAgentActor !== true) {
      throw new TriggerManagementError('agent-not-authorized', 'agent trigger mutations require a capability grant');
    }
    validatePrivateInput(request.input);
    const now = this.now();
    const stored: StoredTriggerPlan = {
      schema: 'aria.trigger-management.plan.v1', apiVersion: TRIGGER_MANAGEMENT_API_VERSION,
      id: randomBytes(16).toString('hex'), command: request.command, status: 'planned',
      actor: actorReference(request.actor), summary: await this.summarize(request.command, request.input),
      input: structuredClone(request.input), createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
    };
    await this.plans.create(stored);
    return resultFor(request.requestId, stored);
  }

  async getPlan(request: TriggerPlanActionRequest): Promise<TriggerPlanResult> {
    validateActionRequest(request);
    return resultFor(request.requestId, await this.requirePlan(request.planId));
  }

  async confirm(request: TriggerPlanActionRequest): Promise<TriggerPlanResult> {
    validateActionRequest(request);
    const plan = await this.plans.update(request.planId, (existing) => {
      requireActor(existing, request.actor); requireCurrent(existing, this.now());
      if (existing.status === 'applied' || existing.status === 'confirmed') return existing;
      return { ...existing, status: 'confirmed', confirmedAt: new Date(this.now()).toISOString() };
    }).catch(planError);
    return resultFor(request.requestId, plan);
  }

  async apply(request: TriggerPlanActionRequest): Promise<TriggerApplyResult> {
    validateActionRequest(request);
    const plan = await this.plans.update(request.planId, (existing) => {
      requireActor(existing, request.actor); requireCurrent(existing, this.now());
      if (existing.status === 'applied') return existing;
      if (existing.status !== 'confirmed') throw new TriggerManagementError('not-confirmed', 'trigger plan is not confirmed');
      return existing;
    }).catch(planError);
    let outcome: { definition?: TriggerDefinition; occurrence?: TriggerApplyResult['occurrence'] } = {};
    if (plan.status !== 'applied') {
      outcome = await this.executeCommand(plan.command, plan.input);
      await this.plans.update(plan.id, (existing) => ({
        ...existing, status: 'applied', appliedAt: new Date(this.now()).toISOString(),
      }));
      await this.options.onApplied?.();
    }
    return {
      schema: 'aria.trigger-management.apply.v1', apiVersion: 1, requestId: request.requestId,
      planId: plan.id, command: plan.command,
      ...(outcome.definition ? { definition: publicDefinition(outcome.definition) } : {}),
      ...(outcome.occurrence ? { occurrence: outcome.occurrence } : {}),
    };
  }

  async execute(request: TriggerExecuteRequest): Promise<TriggerApplyResult> {
    validateExecuteRequest(request);
    const planned = await this.plan({
      schema: 'aria.trigger-management.plan.request.v1', apiVersion: 1,
      requestId: request.requestId, actor: request.actor, command: request.command, input: request.input,
    });
    const action = {
      schema: 'aria.trigger-management.plan-action.request.v1' as const, apiVersion: 1 as const,
      requestId: request.requestId, actor: request.actor, planId: planned.plan.id,
    };
    await this.confirm(action);
    return this.apply(action);
  }

  async read(input: { profileId?: string; definitionId?: string } = {}): Promise<TriggerReadSnapshot> {
    const definitions = input.definitionId
      ? [await this.requireDefinition(input.definitionId)]
      : await this.store.listDefinitions(input.profileId ? { profileId: input.profileId } : undefined);
    const occurrences = input.definitionId
      ? await this.store.listOccurrences({ definitionId: input.definitionId })
      : await this.store.listOccurrences(input.profileId ? { profileId: input.profileId } : undefined);
    return {
      schema: 'aria.trigger-read.snapshot.v1', apiVersion: 1,
      generatedAt: new Date(this.now()).toISOString(), definitions: definitions.map(publicDefinition), occurrences,
    };
  }

  async preview(definitionId: string, count = 5): Promise<TriggerPreviewSnapshot> {
    const definition = await this.requireDefinition(definitionId);
    const { schedule, timeZone } = scheduleContract(definition);
    return {
      schema: 'aria.trigger-read.preview.v1', apiVersion: 1, definitionId,
      schedule, timeZone, fireTimes: previewSchedule(schedule, timeZone, this.now(), count),
    };
  }

  private async executeCommand(command: TriggerManagementCommand, input: Record<string, unknown>) {
    if (command === 'create') return { definition: await this.store.createDefinition(this.createDefinition(input)) };
    if (command === 'retry' || command === 'ack') {
      const occurrenceId = requiredString(input.occurrenceId, 'occurrenceId');
      if (!await this.store.getOccurrence(occurrenceId)) {
        throw new TriggerManagementError('occurrence-not-found', `occurrence not found: ${occurrenceId}`);
      }
      return { occurrence: command === 'retry'
        ? await this.store.retryDead(occurrenceId, this.now())
        : await this.store.acknowledgeDead(occurrenceId, this.now()) };
    }
    const id = requiredString(input.definitionId, 'definitionId');
    const existing = await this.requireDefinition(id);
    if (command === 'run-now') {
      const at = this.now();
      const occurrence = createPendingOccurrence({
        id: this.createId(), profileId: existing.profileId, definitionId: id,
        definitionRevision: existing.revision, scheduledFor: at, createdAt: at,
        metadata: { source: 'manual' },
      });
      return { occurrence: (await this.store.materialize({
        definitionId: id, expectedRevision: existing.revision,
        expectedNextFireAt: existing.nextFireAt, occurrence, nextFireAt: existing.nextFireAt,
        advancedAt: at,
      })).occurrence };
    }
    return { definition: await this.store.replaceDefinition(
      this.updateDefinition(existing, command, input), existing.revision,
    ) };
  }

  private createDefinition(input: Record<string, unknown>): TriggerDefinition {
    const now = this.now();
    const id = optionalString(input.id) ?? this.createId();
    const profileId = requiredString(input.profileId, 'profileId');
    const schedule = requireSchedule(input.schedule);
    const timeZone = optionalString(input.timeZone) ?? 'UTC';
    const prompt = requiredString(input.prompt, 'prompt');
    const conversationRef = optionalString(input.conversationRef);
    const routeId = conversationRef ? 'conversation' : 'history';
    const grant = optionalString(input.authorizationGrantRef) ?? `trigger-grant:${fingerprint(profileId, id)}`;
    const ownerRef = requiredString(input.ownerRef, 'ownerRef');
    const attempts = integer(input.maxAttempts, 3, 1, 10);
    return {
      schemaVersion: TRIGGER_STATE_SCHEMA_VERSION,
      id, profileId, providerId: 'schedule', instanceId: 'host-clock', sourceKind: 'schedule',
      state: input.activate === false ? 'draft' : 'active', revision: 1,
      ownerRef, createdBy: { kind: input.createdBy === 'agent' ? 'agent' : 'user', actorRef: ownerRef },
      authorizationGrantRef: grant,
      authorizationCeiling: {
        maxRuntimeMs: integer(input.maxRuntimeMs, 60_000, 1, 3_600_000),
        maxAttemptsPerOccurrence: attempts, allowWakeProfile: false, allowedResultRouteIds: [routeId],
      },
      triggerSpec: asJson({ schedule, timeZone }),
      intentTemplate: {
        actor: { kind: 'system', actorRef: 'schedule' }, authorizationRef: grant,
        scopeRef: optionalString(input.scopeRef) ?? `trigger:${id}`,
        sessionPolicy: { kind: 'fresh' }, input: { prompt, attachments: [] },
        workspaceRef: { kind: 'profile-default' }, engineRequirements: { inputs: ['text'], capabilities: [] },
        resultRoutes: conversationRef
          ? [{ kind: 'conversation', routeId, conversationRef }]
          : [{ kind: 'history', routeId }],
      },
      retryPolicy: { maxAttempts: attempts, baseDelayMs: 30_000, maxDelayMs: 15 * 60_000, jitterRatio: 0.1 },
      quota: {
        maxActiveOccurrences: integer(input.maxActiveOccurrences, 1, 1, 10),
        maxRunsPerDay: integer(input.maxRunsPerDay, 24, 1, 1_000),
      },
      misfirePolicy: 'coalesce', overlapPolicy: { kind: 'queue-one' },
      nextFireAt: nextScheduleFire(schedule, timeZone, now - 1), createdAt: now, updatedAt: now,
      metadata: { label: optionalString(input.label) ?? id },
    };
  }

  private updateDefinition(existing: TriggerDefinition, command: TriggerManagementCommand, input: Record<string, unknown>): TriggerDefinition {
    const now = this.now();
    if (command === 'pause') return { ...existing, state: 'paused', revision: existing.revision + 1, pausedAt: now, updatedAt: now };
    if (command === 'resume') {
      const { schedule, timeZone } = scheduleContract(existing);
      return { ...existing, state: 'active', revision: existing.revision + 1, pausedAt: undefined,
        nextFireAt: nextScheduleFire(schedule, timeZone, now), updatedAt: now };
    }
    if (command === 'cancel') return { ...existing, state: 'canceled', revision: existing.revision + 1, canceledAt: now, updatedAt: now };
    if (command !== 'update') throw new TriggerManagementError('invalid-request', `unsupported definition command: ${command}`);
    const current = scheduleContract(existing);
    const schedule = input.schedule === undefined ? current.schedule : requireSchedule(input.schedule);
    const timeZone = optionalString(input.timeZone) ?? current.timeZone;
    const prompt = optionalString(input.prompt) ?? existing.intentTemplate.input.prompt;
    const label = optionalString(input.label);
    return {
      ...existing, revision: existing.revision + 1, updatedAt: now,
      triggerSpec: asJson({ schedule, timeZone }),
      nextFireAt: existing.state === 'active' ? nextScheduleFire(schedule, timeZone, now) : existing.nextFireAt,
      intentTemplate: { ...existing.intentTemplate, input: { ...existing.intentTemplate.input, prompt } },
      metadata: { ...existing.metadata, ...(label ? { label } : {}) },
    };
  }

  private async summarize(command: TriggerManagementCommand, input: Record<string, unknown>) {
    if (command === 'create') return [
      { field: 'profile', before: null, after: requiredString(input.profileId, 'profileId') },
      { field: 'schedule.kind', before: null, after: requireSchedule(input.schedule).kind },
      { field: 'result.route', before: null, after: optionalString(input.conversationRef) ? 'conversation' : 'history' },
      { field: 'prompt', before: null, after: '[REDACTED]' },
    ];
    if (command === 'retry' || command === 'ack') {
      return [{ field: 'occurrence.state', before: 'dead', after: command === 'retry' ? 'pending' : 'acknowledged' }];
    }
    const definition = await this.requireDefinition(requiredString(input.definitionId, 'definitionId'));
    if (command === 'update') return [
      { field: 'definition.revision', before: definition.revision, after: definition.revision + 1 },
      ...(input.prompt === undefined ? [] : [{ field: 'prompt', before: '[REDACTED]', after: '[REDACTED]' }]),
    ];
    return [{
      field: 'definition.state', before: definition.state,
      after: command === 'run-now' ? definition.state : command === 'resume' ? 'active' : command === 'pause' ? 'paused' : 'canceled',
    }];
  }

  private async requireDefinition(id: string): Promise<TriggerDefinition> {
    const value = await this.store.getDefinition(id);
    if (!value) throw new TriggerManagementError('definition-not-found', `definition not found: ${id}`);
    return value;
  }

  private async requirePlan(id: string): Promise<StoredTriggerPlan> {
    const value = await this.plans.get(id);
    if (!value) throw new TriggerManagementError('plan-not-found', `trigger plan not found: ${id}`);
    return value;
  }
}

function resultFor(requestId: string, plan: StoredTriggerPlan): TriggerPlanResult {
  return { schema: 'aria.trigger-management.plan-result.v1', apiVersion: 1, requestId, plan: publicPlan(plan) };
}
function publicPlan(plan: StoredTriggerPlan): TriggerPlanSnapshot {
  const { input: _input, ...value } = plan;
  return structuredClone(value);
}
function publicDefinition(definition: TriggerDefinition): TriggerDefinitionReadModel {
  return {
    schemaVersion: definition.schemaVersion,
    id: definition.id,
    profileId: definition.profileId,
    providerId: definition.providerId,
    instanceId: definition.instanceId,
    sourceKind: definition.sourceKind,
    state: definition.state,
    revision: definition.revision,
    owner: { fingerprint: `sha256:${fingerprint('owner', definition.ownerRef)}` },
    createdBy: {
      kind: definition.createdBy.kind,
      actorFingerprint: `sha256:${fingerprint('actor', definition.createdBy.actorRef)}`,
    },
    authorizationGrant: '[REDACTED]',
    authorizationCeiling: structuredClone(definition.authorizationCeiling),
    triggerSpec: structuredClone(definition.triggerSpec),
    intent: {
      scopeFingerprint: `sha256:${fingerprint('scope', definition.intentTemplate.scopeRef)}`,
      sessionPolicy: structuredClone(definition.intentTemplate.sessionPolicy),
      input: { prompt: '[REDACTED]', attachmentCount: definition.intentTemplate.input.attachments.length },
      workspaceRef: structuredClone(definition.intentTemplate.workspaceRef),
      engineRequirements: structuredClone(definition.intentTemplate.engineRequirements),
      resultRoutes: definition.intentTemplate.resultRoutes.map((route) => ({ kind: route.kind, routeId: route.routeId })),
    },
    retryPolicy: structuredClone(definition.retryPolicy),
    quota: structuredClone(definition.quota),
    misfirePolicy: definition.misfirePolicy,
    overlapPolicy: structuredClone(definition.overlapPolicy),
    ...(definition.nextFireAt === undefined ? {} : { nextFireAt: definition.nextFireAt }),
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    ...(definition.scheduleAdvancedAt === undefined ? {} : { scheduleAdvancedAt: definition.scheduleAdvancedAt }),
    ...(definition.pausedAt === undefined ? {} : { pausedAt: definition.pausedAt }),
    ...(definition.canceledAt === undefined ? {} : { canceledAt: definition.canceledAt }),
    metadata: structuredClone(definition.metadata),
  };
}
function validatePlanRequest(request: TriggerPlanRequest): void {
  validateContext(request);
  if (request.schema !== 'aria.trigger-management.plan.request.v1' || !isCommand(request.command)) invalid();
}
function validateActionRequest(request: TriggerPlanActionRequest): void {
  validateContext(request);
  if (request.schema !== 'aria.trigger-management.plan-action.request.v1' || !/^[a-f0-9]{32}$/.test(request.planId)) invalid();
}
function validateExecuteRequest(request: TriggerExecuteRequest): void {
  validateContext(request);
  if (request.schema !== 'aria.trigger-management.execute.request.v1' || !isCommand(request.command)) invalid();
}
function validateContext(request: { apiVersion: number; requestId: string; actor: ControlActorContext }): void {
  if (request.apiVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)
    || !['local-cli', 'agent', 'card', 'web'].includes(request.actor.source) || !request.actor.principal.trim()) invalid();
}
function isCommand(value: string): value is TriggerManagementCommand {
  return ['create', 'update', 'pause', 'resume', 'cancel', 'run-now', 'retry', 'ack'].includes(value);
}
function invalid(): never { throw new TriggerManagementError('invalid-request', 'invalid trigger management request') }
function planError(error: unknown): never {
  if (error instanceof TriggerManagementError) throw error;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'plan-not-found') {
    throw new TriggerManagementError('plan-not-found', 'trigger plan not found');
  }
  throw error;
}
function requireCurrent(plan: StoredTriggerPlan, now: number): void {
  if (Date.parse(plan.expiresAt) <= now) throw new TriggerManagementError('plan-expired', 'trigger plan expired');
}
function requireActor(plan: StoredTriggerPlan, actor: ControlActorContext): void {
  if (plan.actor.source !== actor.source || plan.actor.fingerprint !== actorReference(actor).fingerprint) {
    throw new TriggerManagementError('actor-mismatch', 'trigger plan actor mismatch');
  }
}
function actorReference(actor: ControlActorContext) {
  return { source: actor.source, fingerprint: `sha256:${fingerprint(actor.source, actor.principal)}` };
}
function fingerprint(...values: string[]): string { return createHash('sha256').update(values.join('\0')).digest('hex') }
function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new TriggerManagementError('invalid-request', `${label} is required`);
  return result;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 16_384 ? value.trim() : undefined;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid();
  return value as number;
}
function requireSchedule(value: unknown): ScheduleSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return structuredClone(value) as ScheduleSpec;
}
function scheduleContract(definition: TriggerDefinition): { schedule: ScheduleSpec; timeZone: string } {
  const spec = definition.triggerSpec as { schedule: ScheduleSpec; timeZone: string };
  return { schedule: spec.schedule, timeZone: spec.timeZone };
}
function validatePrivateInput(input: Record<string, unknown>): void {
  const encoded = JSON.stringify(input);
  if (!encoded || Buffer.byteLength(encoded) > 64 * 1024) invalid();
  if (Object.keys(input).some((key) => /secret|password|credential|token/i.test(key))) invalid();
}
function asJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }
