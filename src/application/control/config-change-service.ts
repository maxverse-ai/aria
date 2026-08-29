import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveAppPaths } from '../../config/app-paths';
import type { RootConfig } from '../../config/profile-schema';
import { ControlChangePlanStore } from './change-plan-store';
import { FileConfigRepository, type ConfigRepository } from './config-repository';
import { configRevision } from './config-revision';
import { ManagementCommandRegistry } from './management-command-registry';
import { runtimeEffectRequiresRestart, type ManagementRuntimeEffect } from './runtime-effect';
import {
  CONTROL_CHANGE_API_VERSION,
  ControlChangeError,
  type ConfigMutation,
  type ConfigChangeCommitResult,
  type ControlActorContext,
  type ControlActorReference,
  type ControlChangeApplyResult,
  type ControlChangePlanSnapshot,
  type ControlChangeResource,
  type ControlChangeSummary,
  type ManagementCommandInput,
  type ManagementCommandDefinition,
  type ControlPlanParameters,
  type StoredControlChangePlan,
} from './change-types';

const DEFAULT_PLAN_TTL_MS = 15 * 60_000;

interface PendingConfigCommit {
  commit: ConfigChangeCommitResult;
}

export interface ConfigChangeServiceOptions {
  rootDir?: string;
  registry?: ManagementCommandRegistry;
  /** @deprecated Pass a registry. Retained for application API compatibility. */
  operations?: readonly ManagementCommandInput[];
  repository?: ConfigRepository;
  planTtlMs?: number;
  now?: () => Date;
  createId?: () => string;
  /** Explicit adapter authorization for non-low-risk registered commands. */
  authorizeCommand?: ConfigChangeCommandAuthorizer;
}

export interface ConfigChangeAuthorizationInput {
  actor: ControlActorContext;
  command: Pick<ManagementCommandDefinition, 'id' | 'version' | 'risk' | 'resourceScope'>;
  resource: ControlChangeResource;
}

export type ConfigChangeCommandAuthorizer = (
  input: ConfigChangeAuthorizationInput,
) => boolean;

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
  private readonly registry: ManagementCommandRegistry;
  private readonly repository: ConfigRepository;
  private readonly store: ControlChangePlanStore;
  private readonly planTtlMs: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly rootDir: string;
  private readonly authorizeCommand?: ConfigChangeCommandAuthorizer;

  constructor(options: ConfigChangeServiceOptions = {}) {
    const rootDir = resolveAppPaths({ rootDir: options.rootDir }).rootDir;
    this.rootDir = rootDir;
    if (options.registry && options.operations) {
      throw new Error('pass either registry or operations, not both');
    }
    this.registry = options.registry ?? new ManagementCommandRegistry(options.operations);
    this.repository = options.repository ?? new FileConfigRepository(rootDir);
    this.store = new ControlChangePlanStore(rootDir);
    this.planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomBytes(16).toString('hex'));
    this.authorizeCommand = options.authorizeCommand;
  }

  async createPlan(input: CreateConfigChangePlanInput): Promise<ControlChangePlanSnapshot> {
    validateActor(input.actor);
    const operation = this.requireOperation(input.operationId);
    const { root, profile, resource } = await this.resolveRoot(input.profile, operation);
    if (
      operation.risk !== 'low' &&
      !this.authorizeCommand?.({
        actor: input.actor,
        command: commandAuthorizationView(operation),
        resource,
      })
    ) {
      throw new ControlChangeError(
        'operation-unavailable',
        `risk policy is not available for operation: ${operation.id}`,
      );
    }
    const parameters = structuredClone(input.parameters ?? {});
    validateParameters(parameters, operation.parameterPrivacy ?? 'ordinary');
    const candidate = operation.prepare({
      root: structuredClone(root),
      profile,
      resource,
      parameters,
      rootDir: this.rootDir,
    });
    validateCandidate(root, candidate, resource, operation);
    assertSafePlanPayload(
      parameters,
      candidate.changes,
      root,
      input.actor,
      operation.parameterPrivacy ?? 'ordinary',
    );
    const createdAt = this.now();
    const plan: StoredControlChangePlan = {
      schema: 'aria.control.change-plan.v1',
      apiVersion: CONTROL_CHANGE_API_VERSION,
      id: this.createId(),
      profile,
      resource,
      operation: {
        id: operation.id,
        version: operation.version,
        risk: operation.risk,
        restartRequired: runtimeEffectRequiresRestart(operation.effect),
      },
      status: 'planned',
      actor: actorReference(input.actor),
      baseRevision: configRevision(root),
      targetRevision: configRevision(candidate.deleteRoot ? undefined : candidate.root),
      changes: structuredClone(candidate.changes),
      parameters,
      runtimeEffect: operation.effect,
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
    return (await this.commitPlan(id, actor)).applyResult;
  }

  /** Commit desired state and report its runtime effect without performing it. */
  async commitPlan(id: string, actor: ControlActorContext): Promise<ConfigChangeCommitResult> {
    validateActor(actor);
    return this.repository.withLockedRoot(async (root, commitRoot) => {
      const transaction = await this.store.withLockedPlan<PendingConfigCommit>(id, async (plan) => {
        requireActor(plan, actor);
        if (plan.status === 'applied' && plan.appliedAt) {
          return { plan, result: { commit: commitResult(plan, false) } };
        }
        if (plan.status !== 'confirmed') {
          throw new ControlChangeError('not-confirmed', `plan is not confirmed: ${id}`);
        }
        requireNotExpired(plan, this.now());
        const currentRevision = configRevision(root);
        const appliedAt = this.now().toISOString();

        // Recovery path: config committed, but the previous plan-state write failed.
        if (currentRevision === plan.targetRevision) {
          const recovered = { ...plan, status: 'applied' as const, appliedAt };
          return { plan: recovered, result: { commit: commitResult(recovered, true) } };
        }
        if (currentRevision !== plan.baseRevision) {
          throw new ControlChangeError(
            'revision-conflict',
            `configuration changed since plan creation (${plan.baseRevision} -> ${currentRevision})`,
          );
        }
        if (!root) throw new ControlChangeError('invalid-plan', 'root config not found');
        const operation = this.requireOperation(plan.operation.id);
        if (operation.version !== plan.operation.version) {
          throw new ControlChangeError(
            'operation-unavailable',
            `operation version unavailable: ${plan.operation.id}@${plan.operation.version}`,
          );
        }
        const resource = storedResource(plan);
        const expectedResource = commandResource(operation, plan.profile);
        if (!isDeepStrictEqual(resource, expectedResource)) {
          throw new ControlChangeError(
            'operation-unavailable',
            `operation resource scope changed: ${plan.operation.id}@${plan.operation.version}`,
          );
        }
        if (resource.kind === 'profile' && !root.profiles[resource.profile]) {
          throw new ControlChangeError(
            'profile-not-found',
            `profile not found: ${resource.profile}`,
          );
        }
        const candidate = operation.prepare({
          root: structuredClone(root),
          profile: plan.profile,
          resource,
          parameters: structuredClone(plan.parameters),
          rootDir: this.rootDir,
        });
        validateCandidate(root, candidate, resource, operation);
        const actualTarget = configRevision(candidate.deleteRoot ? undefined : candidate.root);
        if (actualTarget !== plan.targetRevision) {
          throw new ControlChangeError(
            'transformation-drift',
            `operation output changed since planning (${plan.targetRevision} -> ${actualTarget})`,
          );
        }
        const applied = { ...plan, status: 'applied' as const, appliedAt };
        await commitRoot(candidate.deleteRoot ? null : candidate.root);
        return {
          plan: applied,
          result: {
            commit: commitResult(applied, false, operation.effect),
          },
        };
      });
      return { result: transaction.commit };
    });
  }

  private requireOperation(id: string) {
    const operation = this.registry.get(id);
    if (!operation) {
      throw new ControlChangeError('operation-unavailable', `operation unavailable: ${id}`);
    }
    return operation;
  }

  private async resolveRoot(
    requestedProfile: string | undefined,
    operation: ManagementCommandDefinition,
  ): Promise<{ root: RootConfig; profile: string; resource: ControlChangeResource }> {
    const root = await this.repository.readRoot();
    if (!root) throw new ControlChangeError('invalid-plan', 'root config not found');
    const rawProfile = requestedProfile ?? root.activeProfile;
    let profile: string;
    try {
      profile = resolveAppPaths({ rootDir: this.rootDir, profile: rawProfile }).profile;
    } catch {
      throw new ControlChangeError('invalid-plan', `invalid profile name: ${rawProfile}`);
    }
    const resource = commandResource(operation, profile);
    if (resource.kind === 'profile' && !root.profiles[profile]) {
      throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
    }
    return { root, profile, resource };
  }
}

function publicPlan(plan: StoredControlChangePlan): ControlChangePlanSnapshot {
  const { parameters: _parameters, runtimeEffect: _runtimeEffect, ...snapshot } = plan;
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

function validateParameters(
  parameters: ControlPlanParameters,
  privacy: 'ordinary' | 'private-identifiers' = 'ordinary',
): void {
  for (const [key, value] of Object.entries(parameters)) {
    if (
      !key.trim() ||
      /secret|token|credential|password|authorization|path|workspace/i.test(key) ||
      (privacy === 'ordinary' && /app.?id|user.?id|chat.?id/i.test(key)) ||
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
  privacy: 'ordinary' | 'private-identifiers',
): void {
  validateParameters(parameters, privacy);
  const publicSerialized = JSON.stringify(changes);
  const fullSerialized = JSON.stringify({ parameters, changes });
  if (
    changes.some((item) => /secret|token|credential|password|authorization/i.test(item.field)) ||
    /\b(?:ou|oc|om|cli)_[A-Za-z0-9_-]{6,}\b/.test(publicSerialized) ||
    /(?:^|[\s"'=])(?:~\/|[A-Za-z]:\\|\/(?:Users|home|tmp|var|private|Volumes|opt|workspace|workspaces|mnt|app|srv|root|data)\/)/.test(publicSerialized) ||
    (privacy === 'ordinary' &&
      (/\b(?:ou|oc|om|cli)_[A-Za-z0-9_-]{6,}\b/.test(fullSerialized) ||
        /(?:^|[\s"'=])(?:~\/|[A-Za-z]:\\|\/(?:Users|home|tmp|var|private|Volumes|opt|workspace|workspaces|mnt|app|srv|root|data)\/)/.test(fullSerialized)))
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
  const inspected = privacy === 'ordinary' ? fullSerialized : publicSerialized;
  if ([...sensitive].some((value) => value.length >= 4 && inspected.includes(value))) {
    throw new ControlChangeError('invalid-plan', 'plan parameters or summaries contain sensitive data');
  }
}

function commandAuthorizationView(
  command: ManagementCommandDefinition,
): Pick<ManagementCommandDefinition, 'id' | 'version' | 'risk' | 'resourceScope'> {
  return {
    id: command.id,
    version: command.version,
    risk: command.risk,
    resourceScope: command.resourceScope ?? 'profile',
  };
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
  candidate: ConfigMutation,
  resource: ControlChangeResource,
  operation: ManagementCommandDefinition,
): void {
  const { root: after, changes } = candidate;
  if (!Array.isArray(changes) || changes.some((item) => !item.field.trim())) {
    throw new ControlChangeError('invalid-plan', 'operation returned invalid change summaries');
  }
  if (candidate.deleteRoot) {
    if (
      resource.kind !== 'root' ||
      operation.allowsRootDeletion !== true ||
      !isDeepStrictEqual(before, after)
    ) {
      throw new ControlChangeError('invalid-plan', 'operation may not delete root configuration');
    }
    return;
  }
  if (
    after.schemaVersion !== 2 ||
    !after.profiles ||
    typeof after.profiles !== 'object' ||
    !after.activeProfile ||
    !after.profiles[after.activeProfile]
  ) {
    throw new ControlChangeError('invalid-plan', 'operation returned an invalid root configuration');
  }
  if (resource.kind === 'root') return;

  const profile = resource.profile;
  if (!after.profiles[profile]) {
    throw new ControlChangeError('invalid-plan', 'operation returned an invalid profile configuration');
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
}

function commandResource(
  command: ManagementCommandDefinition,
  profile: string,
): ControlChangeResource {
  return command.resourceScope === 'root'
    ? { kind: 'root' }
    : { kind: 'profile', profile };
}

function storedResource(plan: StoredControlChangePlan): ControlChangeResource {
  return plan.resource ?? { kind: 'profile', profile: plan.profile };
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

function commitResult(
  plan: StoredControlChangePlan,
  recovered: boolean,
  effect: ManagementRuntimeEffect = plan.runtimeEffect ?? (plan.operation.restartRequired ? 'restart' : 'none'),
): ConfigChangeCommitResult {
  return { applyResult: applyResult(plan, recovered), effect };
}
