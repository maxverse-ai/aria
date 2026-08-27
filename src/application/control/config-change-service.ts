import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveAppPaths } from '../../config/app-paths';
import type { RootConfig } from '../../config/profile-schema';
import {
  loadRootConfig,
  readActiveProfile,
  saveRootConfig,
  withConfigFileLock,
} from '../../config/profile-store';
import { ControlChangePlanStore } from './change-plan-store';
import { configRevision } from './config-revision';
import {
  CONTROL_CHANGE_API_VERSION,
  ControlChangeError,
  type ConfigChangeOperation,
  type ControlActorContext,
  type ControlActorReference,
  type ControlChangeApplyResult,
  type ControlChangePlanSnapshot,
  type ControlChangeSummary,
  type ControlPlanParameters,
  type StoredControlChangePlan,
} from './change-types';

const DEFAULT_PLAN_TTL_MS = 15 * 60_000;

export interface ConfigChangeServiceOptions {
  rootDir?: string;
  operations?: readonly ConfigChangeOperation[];
  planTtlMs?: number;
  now?: () => Date;
  createId?: () => string;
}

export interface CreateConfigChangePlanInput {
  profile?: string;
  operationId: string;
  parameters?: ControlPlanParameters;
  actor: ControlActorContext;
}

/**
 * Application boundary for all future configuration writers. Adapters may
 * only select a registered operation and supply actor context; there is no
 * generic JSON-patch escape hatch.
 */
export class ConfigChangeService {
  private readonly rootDir: string;
  private readonly operations = new Map<string, ConfigChangeOperation>();
  private readonly store: ControlChangePlanStore;
  private readonly planTtlMs: number;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: ConfigChangeServiceOptions = {}) {
    this.rootDir = resolveAppPaths({ rootDir: options.rootDir }).rootDir;
    for (const operation of options.operations ?? []) {
      if (this.operations.has(operation.id)) throw new Error(`duplicate operation: ${operation.id}`);
      this.operations.set(operation.id, operation);
    }
    this.store = new ControlChangePlanStore(this.rootDir);
    this.planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomBytes(16).toString('hex'));
  }

  async createPlan(input: CreateConfigChangePlanInput): Promise<ControlChangePlanSnapshot> {
    validateActor(input.actor);
    const operation = this.requireOperation(input.operationId);
    if (operation.risk !== 'low') {
      throw new ControlChangeError(
        'operation-unavailable',
        `risk policy is not available for operation: ${operation.id}`,
      );
    }
    const { root, profile } = await this.resolveRoot(input.profile);
    const parameters = structuredClone(input.parameters ?? {});
    validateParameters(parameters);
    const candidate = operation.prepare({ root: structuredClone(root), profile, parameters });
    validateCandidate(root, candidate.root, profile, candidate.changes);
    assertSafePlanPayload(parameters, candidate.changes, root, input.actor);
    const createdAt = this.now();
    const plan: StoredControlChangePlan = {
      schema: 'aria.control.change-plan.v1',
      apiVersion: CONTROL_CHANGE_API_VERSION,
      id: this.createId(),
      profile,
      operation: {
        id: operation.id,
        version: operation.version,
        risk: operation.risk,
        restartRequired: operation.restartRequired,
      },
      status: 'planned',
      actor: actorReference(input.actor),
      baseRevision: configRevision(root),
      targetRevision: configRevision(candidate.root),
      changes: structuredClone(candidate.changes),
      parameters,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.planTtlMs).toISOString(),
    };
    if (plan.baseRevision === plan.targetRevision || plan.changes.length === 0) {
      throw new ControlChangeError('invalid-plan', 'operation produced no configuration change');
    }
    await this.store.create(plan);
    return publicPlan(plan);
  }

  async getPlan(id: string): Promise<ControlChangePlanSnapshot> {
    const plan = await this.store.read(id);
    if (!plan) throw new ControlChangeError('plan-not-found', `plan not found: ${id}`);
    return publicPlan(plan);
  }

  async confirmPlan(id: string, actor: ControlActorContext): Promise<ControlChangePlanSnapshot> {
    validateActor(actor);
    return this.store.withLockedPlan(id, async (plan) => {
      requireActor(plan, actor);
      if (plan.status === 'applied' || plan.status === 'confirmed') {
        return { plan, result: publicPlan(plan) };
      }
      requireNotExpired(plan, this.now());
      const next: StoredControlChangePlan = {
        ...plan,
        status: 'confirmed',
        confirmedAt: this.now().toISOString(),
      };
      return { plan: next, result: publicPlan(next) };
    });
  }

  async applyPlan(id: string, actor: ControlActorContext): Promise<ControlChangeApplyResult> {
    validateActor(actor);
    const appPaths = resolveAppPaths({ rootDir: this.rootDir });
    return withConfigFileLock(appPaths.configFile, async () =>
      this.store.withLockedPlan(id, async (plan) => {
        requireActor(plan, actor);
        if (plan.status === 'applied' && plan.appliedAt) {
          return { plan, result: applyResult(plan, false) };
        }
        if (plan.status !== 'confirmed') {
          throw new ControlChangeError('not-confirmed', `plan is not confirmed: ${id}`);
        }
        requireNotExpired(plan, this.now());
        const root = await loadRootConfig(appPaths.configFile);
        if (!root) throw new ControlChangeError('invalid-plan', 'root config not found');
        const currentRevision = configRevision(root);
        const appliedAt = this.now().toISOString();

        // Recovery path: config committed, but the previous plan-state write failed.
        if (currentRevision === plan.targetRevision) {
          const recovered = { ...plan, status: 'applied' as const, appliedAt };
          return { plan: recovered, result: applyResult(recovered, true) };
        }
        if (currentRevision !== plan.baseRevision) {
          throw new ControlChangeError(
            'revision-conflict',
            `configuration changed since plan creation (${plan.baseRevision} -> ${currentRevision})`,
          );
        }
        if (!root.profiles[plan.profile]) {
          throw new ControlChangeError('profile-not-found', `profile not found: ${plan.profile}`);
        }
        const operation = this.requireOperation(plan.operation.id);
        if (operation.version !== plan.operation.version) {
          throw new ControlChangeError(
            'operation-unavailable',
            `operation version unavailable: ${plan.operation.id}@${plan.operation.version}`,
          );
        }
        const candidate = operation.prepare({
          root: structuredClone(root),
          profile: plan.profile,
          parameters: structuredClone(plan.parameters),
        });
        validateCandidate(root, candidate.root, plan.profile, candidate.changes);
        const actualTarget = configRevision(candidate.root);
        if (actualTarget !== plan.targetRevision) {
          throw new ControlChangeError(
            'transformation-drift',
            `operation output changed since planning (${plan.targetRevision} -> ${actualTarget})`,
          );
        }
        await saveRootConfig(candidate.root, appPaths.configFile);
        const applied = { ...plan, status: 'applied' as const, appliedAt };
        return { plan: applied, result: applyResult(applied, false) };
      }),
    );
  }

  private requireOperation(id: string): ConfigChangeOperation {
    const operation = this.operations.get(id);
    if (!operation) {
      throw new ControlChangeError('operation-unavailable', `operation unavailable: ${id}`);
    }
    return operation;
  }

  private async resolveRoot(requestedProfile?: string): Promise<{ root: RootConfig; profile: string }> {
    const appPaths = resolveAppPaths({ rootDir: this.rootDir });
    const root = await loadRootConfig(appPaths.configFile);
    if (!root) throw new ControlChangeError('invalid-plan', 'root config not found');
    const active = (await readActiveProfile(this.rootDir)) ?? root.activeProfile;
    const profile = requestedProfile ?? active;
    if (!root.profiles[profile]) {
      throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
    }
    return { root, profile };
  }
}

function publicPlan(plan: StoredControlChangePlan): ControlChangePlanSnapshot {
  const { parameters: _parameters, ...snapshot } = plan;
  return structuredClone(snapshot);
}

function actorReference(actor: ControlActorContext): ControlActorReference {
  return {
    source: actor.source,
    fingerprint: `sha256:${createHash('sha256').update(`${actor.source}\0${actor.principal}`).digest('hex')}`,
  };
}

function validateActor(actor: ControlActorContext): void {
  if (!['local-cli', 'agent', 'card', 'web'].includes(actor.source) || !actor.principal.trim()) {
    throw new ControlChangeError('actor-mismatch', 'valid actor source and principal are required');
  }
}

function validateParameters(parameters: ControlPlanParameters): void {
  for (const [key, value] of Object.entries(parameters)) {
    if (
      !key.trim() ||
      /secret|token|credential|password|authorization|app.?id|user.?id|chat.?id|path|workspace/i.test(key) ||
      (value !== null && !['string', 'number', 'boolean'].includes(typeof value))
    ) {
      throw new ControlChangeError('invalid-plan', 'operation parameters must be named JSON scalars');
    }
  }
}

function assertSafePlanPayload(
  parameters: ControlPlanParameters,
  changes: ControlChangeSummary[],
  root: RootConfig,
  actor: ControlActorContext,
): void {
  const serialized = JSON.stringify({ parameters, changes });
  if (
    changes.some((item) => /secret|token|credential|password|authorization/i.test(item.field)) ||
    /\b(?:ou|oc|om|cli)_[A-Za-z0-9_-]{6,}\b/.test(serialized) ||
    /(?:^|[\s"'=])(?:~\/|[A-Za-z]:\\|\/(?:Users|home|tmp|var|private|Volumes|opt|workspace|workspaces|mnt|app|srv|root|data)\/)/.test(serialized)
  ) {
    throw new ControlChangeError('invalid-plan', 'plan parameters or summaries contain sensitive data');
  }
  const sensitive = new Set<string>([actor.principal]);
  collectStrings(root.secrets, sensitive);
  for (const profile of Object.values(root.profiles)) {
    sensitive.add(profile.accounts.app.id);
    collectStrings(profile.accounts.app.secret, sensitive);
    collectStrings(profile.secrets, sensitive);
    collectStrings(profile.access.allowedUsers, sensitive);
    collectStrings(profile.access.allowedChats, sensitive);
    collectStrings(profile.access.admins, sensitive);
    collectStrings(Object.keys(profile.access.chatRequireMention ?? {}), sensitive);
    collectStrings(profile.workspaces, sensitive);
  }
  if ([...sensitive].some((value) => value.length >= 4 && serialized.includes(value))) {
    throw new ControlChangeError('invalid-plan', 'plan parameters or summaries contain sensitive data');
  }
}

function collectStrings(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, output));
  }
}

function requireActor(plan: StoredControlChangePlan, actor: ControlActorContext): void {
  const actual = actorReference(actor);
  if (actual.source !== plan.actor.source || actual.fingerprint !== plan.actor.fingerprint) {
    throw new ControlChangeError('actor-mismatch', 'plan actor does not match the current actor');
  }
}

function requireNotExpired(plan: StoredControlChangePlan, now: Date): void {
  if (now.getTime() >= Date.parse(plan.expiresAt)) {
    throw new ControlChangeError('expired', `plan expired at ${plan.expiresAt}`);
  }
}

function validateCandidate(
  before: RootConfig,
  after: RootConfig,
  profile: string,
  changes: ControlChangeSummary[],
): void {
  if (after.schemaVersion !== 2 || !after.profiles[profile]) {
    throw new ControlChangeError('invalid-plan', 'operation returned an invalid root/profile configuration');
  }
  if (before.activeProfile !== after.activeProfile || before.schemaVersion !== after.schemaVersion) {
    throw new ControlChangeError('invalid-plan', 'profile operation may not change root identity fields');
  }
  if (!isDeepStrictEqual(before.secrets, after.secrets)) {
    throw new ControlChangeError('invalid-plan', 'profile operation may not change root secrets');
  }
  const beforeNames = Object.keys(before.profiles).sort();
  const afterNames = Object.keys(after.profiles).sort();
  if (!isDeepStrictEqual(beforeNames, afterNames)) {
    throw new ControlChangeError('invalid-plan', 'profile operation may not add or remove profiles');
  }
  for (const name of beforeNames) {
    if (name !== profile && !isDeepStrictEqual(before.profiles[name], after.profiles[name])) {
      throw new ControlChangeError('invalid-plan', `profile operation may not change profile: ${name}`);
    }
  }
  if (!Array.isArray(changes) || changes.some((item) => !item.field.trim())) {
    throw new ControlChangeError('invalid-plan', 'operation returned invalid change summaries');
  }
}

function applyResult(plan: StoredControlChangePlan, recovered: boolean): ControlChangeApplyResult {
  return {
    schema: 'aria.control.change-apply.v1',
    apiVersion: CONTROL_CHANGE_API_VERSION,
    planId: plan.id,
    profile: plan.profile,
    baseRevision: plan.baseRevision,
    resultRevision: plan.targetRevision,
    appliedAt: plan.appliedAt!,
    recovered,
    restartRequired: plan.operation.restartRequired,
  };
}
