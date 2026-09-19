import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ControlActorContext } from '../../application/control';
import { engineSupportsAutomation } from '../../agent/plugin/registry';
import { TriggerManagementApi, type TriggerDefinitionReadModel } from '../operations';
import type { ScheduleSpec } from '../schedule';
import {
  FileAgentTriggerGrantStore,
  tokenDigest,
  type AgentTriggerGrantStore,
} from './grant-store';
import {
  AGENT_TRIGGER_GRANT_CAPABILITY,
  type AgentTriggerGrantIssueInput,
  type AgentTriggerGrantIssueResult,
  type AgentTriggerGrantLimits,
  type AgentTriggerGrantRecord,
  type AgentTriggerGrantView,
  type AgentTriggerRequest,
  type AgentTriggerResult,
} from './types';

const MAX_GRANT_LIFETIME_MS = 90 * 24 * 60 * 60_000;

export interface AgentTriggerGovernanceApiOptions {
  rootDir: string;
  api?: TriggerManagementApi;
  store?: AgentTriggerGrantStore;
  now?: () => number;
  createId?: () => string;
  createSecret?: () => string;
  supportsEngine?: (engineId: string) => boolean;
}

/** Capability-token boundary for autonomous trigger management. */
export class AgentTriggerGovernanceApi {
  private readonly api: TriggerManagementApi;
  private readonly store: AgentTriggerGrantStore;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createSecret: () => string;
  private readonly supportsEngine: (engineId: string) => boolean;

  constructor(options: AgentTriggerGovernanceApiOptions) {
    this.api = options.api ?? new TriggerManagementApi({ rootDir: options.rootDir, allowAgentActor: true });
    this.store = options.store ?? new FileAgentTriggerGrantStore(join(options.rootDir, 'triggers', 'agent-grants.v1.json'));
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.createSecret = options.createSecret ?? (() => randomBytes(32).toString('base64url'));
    this.supportsEngine = options.supportsEngine
      ?? ((engineId) => engineSupportsAutomation(engineId, AGENT_TRIGGER_GRANT_CAPABILITY));
  }

  async issue(input: AgentTriggerGrantIssueInput, actor: ControlActorContext): Promise<AgentTriggerGrantIssueResult> {
    requireAdministrator(actor);
    const now = this.now();
    const profileId = identifier(input.profileId, 'profileId');
    const engineId = identifier(input.engineId, 'engineId');
    if (!this.supportsEngine(engineId)) throw governanceError('unsupported-engine-capability', `engine does not advertise ${AGENT_TRIGGER_GRANT_CAPABILITY}`);
    const principal = bounded(input.principal, 'principal', 256);
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > MAX_GRANT_LIFETIME_MS) {
      throw governanceError('invalid-grant-expiry', 'grant expiry must be in the future and within 90 days');
    }
    const id = this.createId();
    const token = `${id}.${this.createSecret()}`;
    const grant = await this.store.create({
      schemaVersion: 1,
      id,
      capability: AGENT_TRIGGER_GRANT_CAPABILITY,
      state: 'active',
      profileId,
      engineId,
      principal,
      tokenDigest: tokenDigest(token),
      limits: limits(input.limits),
      issuedByFingerprint: actorFingerprint(actor),
      createdAt: now,
      expiresAt,
    });
    return {
      schema: 'aria.agent-trigger-grant.issue.v1',
      apiVersion: 1,
      grant: publicGrant(grant),
      token,
    };
  }

  async revoke(id: string, actor: ControlActorContext): Promise<AgentTriggerGrantView> {
    requireAdministrator(actor);
    return publicGrant(await this.store.revoke(identifier(id, 'grantId'), this.now()));
  }

  /** Read-only grant enumeration for operator adapters. */
  async list(actor: ControlActorContext): Promise<AgentTriggerGrantView[]> {
    requireAdministrator(actor);
    return (await this.store.list()).map(publicGrant);
  }

  /** Read one grant by id; undefined when it does not exist. */
  async get(id: string, actor: ControlActorContext): Promise<AgentTriggerGrantView | undefined> {
    requireAdministrator(actor);
    const grant = await this.store.get(identifier(id, 'grantId'));
    return grant ? publicGrant(grant) : undefined;
  }

  async execute(request: AgentTriggerRequest): Promise<AgentTriggerResult> {
    validateRequest(request);
    const grant = await this.authorize(request.grantToken, request.engineId);
    const actor = { source: 'agent' as const, principal: grant.principal };
    if (request.command === 'list') {
      return result(request, { snapshot: await this.ownedSnapshot(grant) });
    }
    if (request.command === 'history') {
      const definition = await this.requireOwned(grant, required(request.input.definitionId, 'definitionId'));
      return result(request, { snapshot: await this.api.read({ definitionId: definition.id }) });
    }
    if (request.command === 'create') {
      const current = await this.ownedSnapshot(grant);
      const active = current.definitions.filter((item) => item.state !== 'canceled');
      if (active.length >= grant.limits.maxActiveDefinitions) {
        throw governanceError('agent-trigger-quota', 'agent trigger active-definition quota exceeded');
      }
      const schedule = scheduleSpec(request.input.schedule, grant, this.now());
      const prompt = bounded(request.input.prompt, 'prompt', grant.limits.maxPromptBytes, true);
      const definition = (await this.managementExecute('create', {
        profileId: grant.profileId,
        ownerRef: ownerRef(grant),
        createdBy: 'agent',
        authorizationGrantRef: `agent-trigger-grant:${grant.id}`,
        label: optionalBounded(request.input.label, 'label', 256) ?? `Agent reminder ${grant.id.slice(0, 8)}`,
        schedule,
        timeZone: optionalBounded(request.input.timeZone, 'timeZone', 128) ?? 'UTC',
        prompt,
        scopeRef: `agent-trigger:${grant.id}`,
        maxRuntimeMs: grant.limits.maxRuntimeMs,
        maxAttempts: 3,
        maxActiveOccurrences: 1,
        maxRunsPerDay: grant.limits.maxRunsPerDay,
      }, actor)).definition;
      return result(request, { definition: requireDefinition(definition) });
    }

    const definitionId = required(request.input.definitionId, 'definitionId');
    await this.requireOwned(grant, definitionId);
    if (request.command === 'cancel') {
      return result(request, { definition: requireDefinition((await this.managementExecute('cancel', { definitionId }, actor)).definition) });
    }
    if (request.command === 'update') {
      const prompt = bounded(request.input.prompt, 'prompt', grant.limits.maxPromptBytes, true);
      return result(request, { definition: requireDefinition((await this.managementExecute('update', { definitionId, prompt }, actor)).definition) });
    }
    const at = futureDateTime(request.input.at, this.now());
    if (!grant.limits.allowedScheduleKinds.includes('once')) {
      throw governanceError('schedule-not-authorized', 'grant does not allow one-time schedules');
    }
    return result(request, {
      definition: requireDefinition((await this.managementExecute('update', {
        definitionId,
        schedule: { kind: 'once', at },
      }, actor)).definition),
    });
  }

  private async authorize(token: string, engineId: string): Promise<AgentTriggerGrantRecord> {
    const grant = await this.store.authenticate(token);
    if (!grant || grant.state !== 'active' || grant.expiresAt <= this.now()
      || grant.engineId !== engineId || grant.capability !== AGENT_TRIGGER_GRANT_CAPABILITY) {
      throw governanceError('invalid-agent-trigger-grant', 'agent trigger capability grant is invalid or expired');
    }
    return grant;
  }

  private async ownedSnapshot(grant: AgentTriggerGrantRecord) {
    const snapshot = await this.api.read({ profileId: grant.profileId });
    const fingerprint = ownerFingerprint(ownerRef(grant));
    const definitions = snapshot.definitions.filter((item) => item.owner.fingerprint === fingerprint);
    const ids = new Set(definitions.map((item) => item.id));
    return { ...snapshot, definitions, occurrences: snapshot.occurrences.filter((item) => ids.has(item.definitionId)) };
  }

  private async requireOwned(grant: AgentTriggerGrantRecord, definitionId: string): Promise<TriggerDefinitionReadModel> {
    const definition = (await this.api.read({ definitionId })).definitions[0];
    if (!definition || definition.profileId !== grant.profileId || definition.owner.fingerprint !== ownerFingerprint(ownerRef(grant))) {
      throw governanceError('agent-trigger-forbidden', 'trigger definition is not owned by this grant');
    }
    return definition;
  }

  private managementExecute(command: 'create' | 'update' | 'cancel', input: Record<string, unknown>, actor: ControlActorContext) {
    return this.api.execute({
      schema: 'aria.trigger-management.execute.request.v1',
      apiVersion: 1,
      requestId: this.createId(),
      actor,
      command,
      input,
    });
  }
}

function limits(input: Partial<AgentTriggerGrantLimits> | undefined): AgentTriggerGrantLimits {
  const allowed = input?.allowedScheduleKinds ?? ['once'];
  if (!Array.isArray(allowed) || allowed.length === 0
    || allowed.some((kind) => !['once', 'daily', 'weekly'].includes(kind))) {
    throw governanceError('invalid-grant-limits', 'invalid allowed schedule kinds');
  }
  return {
    maxActiveDefinitions: integer(input?.maxActiveDefinitions, 3, 1, 20),
    maxRunsPerDay: integer(input?.maxRunsPerDay, 4, 1, 100),
    maxRuntimeMs: integer(input?.maxRuntimeMs, 60_000, 1_000, 600_000),
    maxPromptBytes: integer(input?.maxPromptBytes, 8_192, 1, 32_768),
    allowedScheduleKinds: [...new Set(allowed)],
  };
}

function scheduleSpec(value: unknown, grant: AgentTriggerGrantRecord, now: number): ScheduleSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw governanceError('invalid-agent-trigger', 'schedule is required');
  const schedule = structuredClone(value) as ScheduleSpec;
  if (!grant.limits.allowedScheduleKinds.includes(schedule.kind as 'once' | 'daily' | 'weekly')) {
    throw governanceError('schedule-not-authorized', `schedule kind is not authorized: ${String(schedule.kind)}`);
  }
  if (schedule.kind === 'once') return { ...schedule, at: futureDateTime(schedule.at, now) };
  return schedule;
}

function validateRequest(request: AgentTriggerRequest): void {
  if (request.schema !== 'aria.agent-trigger.execute.request.v1' || request.apiVersion !== 1
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)
    || !['create', 'list', 'history', 'snooze', 'update', 'cancel'].includes(request.command)
    || !request.grantToken || !request.engineId || !request.input || Array.isArray(request.input)) {
    throw governanceError('invalid-agent-trigger', 'invalid agent trigger request');
  }
}

function requireAdministrator(actor: ControlActorContext): void {
  if (!['local-cli', 'web'].includes(actor.source) || !actor.principal.trim()) {
    throw governanceError('grant-admin-required', 'agent trigger grants require an operator');
  }
}

function publicGrant(grant: AgentTriggerGrantRecord): AgentTriggerGrantView {
  const { principal, tokenDigest: _tokenDigest, issuedByFingerprint, ...publicFields } = grant;
  return {
    ...structuredClone(publicFields),
    principalFingerprint: `sha256:${hash(principal)}`,
    issuedBy: { fingerprint: issuedByFingerprint },
  };
}

function result(request: AgentTriggerRequest, value: Pick<AgentTriggerResult, 'definition' | 'snapshot'>): AgentTriggerResult {
  return {
    schema: 'aria.agent-trigger.execute.result.v1',
    apiVersion: 1,
    requestId: request.requestId,
    command: request.command,
    ...(value.definition ? { definition: value.definition } : {}),
    ...(value.snapshot ? { snapshot: value.snapshot } : {}),
  };
}

function ownerRef(grant: AgentTriggerGrantRecord): string {
  return `agent-grant:${grant.id}:${grant.principal}`;
}
function ownerFingerprint(value: string): string { return `sha256:${createHash('sha256').update(`owner\0${value}`).digest('hex')}` }
function actorFingerprint(actor: ControlActorContext): string { return `sha256:${hash(`${actor.source}\0${actor.principal}`)}` }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function identifier(value: unknown, name: string): string {
  const result = bounded(value, name, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw governanceError('invalid-grant', `${name} is invalid`);
  return result;
}
function required(value: unknown, name: string): string { return bounded(value, name, 16_384) }
function bounded(value: unknown, name: string, maxBytes: number, byBytes = false): string {
  if (typeof value !== 'string' || !value.trim()) throw governanceError('invalid-agent-trigger', `${name} is required`);
  const normalized = value.trim();
  const size = byBytes ? Buffer.byteLength(normalized) : normalized.length;
  if (size > maxBytes) throw governanceError('invalid-agent-trigger', `${name} exceeds its limit`);
  return normalized;
}
function optionalBounded(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : bounded(value, name, max);
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw governanceError('invalid-grant-limits', 'invalid grant limit');
  }
  return value as number;
}
function futureDateTime(value: unknown, now: number): string {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at) || at <= now) throw governanceError('invalid-agent-trigger-time', 'time must be in the future');
  return new Date(at).toISOString();
}
function requireDefinition(value: TriggerDefinitionReadModel | undefined): TriggerDefinitionReadModel {
  if (!value) throw new Error('trigger management result did not include a definition');
  return value;
}
function governanceError(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
