import { compareStableVersions, newestRelease } from './semver';
import {
  UPDATE_OPERATION_SCHEMA_VERSION,
  UPDATE_PLAN_SCHEMA_VERSION,
  type InstalledVersion,
  type DistributionRepository,
  type ReleaseDescriptor,
  type ReleaseSource,
  type ReleaseVerifier,
  type ServiceOrchestrator,
  type StableLauncherPort,
  type UpdateOperationStatus,
  type UpdateOperationV1,
  type UpdatePlanV1,
  type VersionInstaller,
} from './types';

export interface UpdateCheckResult {
  current: InstalledVersion | null;
  latest: ReleaseDescriptor | null;
  updateAvailable: boolean;
  reason: 'not-installed' | 'newer-version' | 'different-build' | 'up-to-date' | 'no-release';
}

export interface CreateUpdatePlanOptions {
  version?: string;
  force?: boolean;
  ttlMs?: number;
}

export interface UpdatePlanReport {
  plan: UpdatePlanV1;
  state: 'active' | 'expired' | 'cancelled';
  operations: UpdateOperationV1[];
}

export class DistributionService {
  constructor(
    private readonly store: DistributionRepository,
    private readonly source: ReleaseSource,
    private readonly verifier: ReleaseVerifier,
    private readonly installer: VersionInstaller,
    private readonly services: ServiceOrchestrator,
    private readonly launcher: StableLauncherPort,
    private readonly legacyCurrent: InstalledVersion | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(): Promise<UpdateCheckResult> {
    const state = await this.store.readState();
    const current = state.current ?? this.legacyCurrent;
    const latest = newestRelease(await this.source.list('internal')) ?? null;
    if (!latest) return { current, latest, updateAvailable: false, reason: 'no-release' };
    if (!current) return { current, latest, updateAvailable: true, reason: 'not-installed' };
    const comparison = compareStableVersions(latest.version, current.version);
    if (comparison > 0) return { current, latest, updateAvailable: true, reason: 'newer-version' };
    if (comparison === 0 && latest.commit !== current.commit) {
      return { current, latest, updateAvailable: true, reason: 'different-build' };
    }
    return { current, latest, updateAvailable: false, reason: 'up-to-date' };
  }

  async createPlan(options: CreateUpdatePlanOptions = {}): Promise<UpdatePlanV1> {
    const releases = await this.source.list('internal');
    const target = options.version
      ? releases.find((release) => release.version === options.version)
      : newestRelease(releases);
    if (!target) {
      const suffix = options.version ? ` for version ${options.version}` : '';
      throw new Error(`no complete immutable internal release is available${suffix}`);
    }
    const state = await this.store.readState({ repository: target.repository });
    const current = state.current ?? this.legacyCurrent;
    if (current && compareStableVersions(target.version, current.version) < 0 && !options.force) {
      throw new Error('target release is older than the active version; use rollback or pass --force');
    }
    const planId = this.store.newId('plan');
    const directory = this.store.downloadPath(planId);
    await this.source.download(target, directory);
    const verified = await this.verifier.verify(target, directory);
    if (current?.sha256 === verified.manifest.sha256) throw new Error('target release is already active');
    const serviceTargets = await this.services.discover();
    if (!current && serviceTargets.length > 0) {
      throw new Error('existing Aria services cannot be adopted by the standalone installer; run update from the currently installed aria command');
    }
    const createdAt = this.now();
    const plan: UpdatePlanV1 = {
      schemaVersion: UPDATE_PLAN_SCHEMA_VERSION,
      id: planId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + (options.ttlMs ?? 60 * 60 * 1000)).toISOString(),
      channel: 'internal',
      repository: target.repository,
      expectedCurrentSha256: current?.sha256 ?? null,
      current,
      target: { ...target, sha256: verified.manifest.sha256 },
      downloadDirectory: directory,
      services: serviceTargets,
      force: options.force === true,
    };
    await this.store.writePlan(plan);
    return plan;
  }

  async apply(planId: string, operationId = this.store.newId('op')): Promise<UpdateOperationV1> {
    const plan = await this.store.readPlan(planId);
    const operation = newUpdateOperation(operationId, plan, this.now());
    await this.store.writeOperation(operation);
    try {
      return await this.store.withLock(() => this.applyLocked(plan, operation));
    } catch (err) {
      await this.failPendingOperation(operationId, err);
      throw err;
    }
  }

  async rollback(force = false, operationId = this.store.newId('op')): Promise<UpdateOperationV1> {
    try {
      return await this.store.withLock(() => this.rollbackLocked(force, operationId));
    } catch (err) {
      await this.failPendingOperation(operationId, err);
      throw err;
    }
  }

  async status(operationId?: string): Promise<UpdateOperationV1 | undefined> {
    return operationId
      ? await this.store.readOperation(operationId)
      : await this.store.readLatestOperation();
  }

  /**
   * Read-back for `aria update plan-show`: the persisted plan plus the
   * derived lifecycle state and every operation that consumed it.
   */
  async planStatus(planId: string): Promise<UpdatePlanReport> {
    const plan = await this.store.readPlan(planId);
    const operations = (await this.store.listOperations()).filter(
      (operation) => operation.planId === planId,
    );
    return { plan, state: updatePlanState(plan, this.now()), operations };
  }

  /**
   * Mark a plan cancelled. The plan file stays on disk as evidence — the
   * `cancelledAt` timestamp is what `apply` rejects. Serialized under the
   * store lock so it cannot race an in-flight apply: a running apply holds
   * the lock and this call fails honestly instead of marking mid-flight.
   */
  async cancelPlan(planId: string): Promise<UpdatePlanV1> {
    return this.store.withLock(async () => {
      const plan = await this.store.readPlan(planId);
      if (plan.cancelledAt) return plan;
      const consumed = (await this.store.listOperations()).some(
        (operation) => operation.planId === planId && operation.status === 'succeeded',
      );
      if (consumed) {
        throw new Error(`update plan ${planId} was already applied; nothing to cancel`);
      }
      plan.cancelledAt = this.now().toISOString();
      await this.store.writePlan(plan);
      return plan;
    });
  }

  private async applyLocked(plan: UpdatePlanV1, operation: UpdateOperationV1): Promise<UpdateOperationV1> {
    let switched = false;
    let previous: InstalledVersion | null = null;
    let installed: InstalledVersion | null = null;
    let targets = plan.services;
    try {
      // Re-read under the lock so a cancel that landed after `apply`'s
      // optimistic read still stops the apply before any I/O.
      plan = await this.store.readPlan(plan.id);
      assertPlanFresh(plan, this.now());
      transition(operation, 'verifying', this.now());
      await this.store.writeOperation(operation);
      const state = await this.store.readState({ repository: plan.repository });
      previous = state.current ?? plan.current;
      if ((previous?.sha256 ?? null) !== plan.expectedCurrentSha256) {
        throw new Error('active installation changed after the update plan was created');
      }
      if (previous) await this.installer.smokeTest(previous);
      const remote = await this.resolveExactRelease(plan.target);
      const verified = await this.verifier.verify(remote, plan.downloadDirectory);
      if (verified.manifest.sha256 !== plan.target.sha256) {
        throw new Error('release digest changed after the update plan was created');
      }
      if (previous && verified.manifest.minRollbackVersion
        && compareStableVersions(previous.version, verified.manifest.minRollbackVersion) < 0) {
        throw new Error(`update requires rollback baseline ${verified.manifest.minRollbackVersion} or newer`);
      }
      targets = await this.services.discover();
      if (!previous && targets.length > 0) {
        throw new Error('services appeared after planning but no rollback baseline exists; create a new plan from the active aria command');
      }
      await this.services.assertSafe(targets, plan.force);

      transition(operation, 'installing', this.now());
      await this.store.writeOperation(operation);
      installed = await this.installer.install(verified);
      await this.installer.smokeTest(installed);
      await this.launcher.write();

      // Installation may take long enough for new work to begin. Re-read both
      // service inventory and activity immediately before the atomic
      // pointer/service transition so the earlier preflight cannot go stale.
      targets = await this.services.discover();
      if (!previous && targets.length > 0) {
        throw new Error('services appeared during installation but no rollback baseline exists');
      }
      await this.services.assertSafe(targets, plan.force);

      transition(operation, 'switching', this.now());
      operation.previous = previous;
      operation.installed = installed;
      await this.store.writeOperation(operation);
      await this.store.writeState({
        ...state,
        repository: plan.repository,
        current: installed,
        previous,
        versions: mergeVersions(installed, previous, state.versions),
      });
      switched = true;

      transition(operation, 'restarting', this.now());
      await this.store.writeOperation(operation);
      const spec = this.launcher.launchSpec();
      await this.services.reconcileLaunchers(targets, {
        runtimePath: spec.runtimePath,
        entryPath: spec.entryPath,
      });
      await this.services.restartAndCheck(targets, installed.version);
      transition(operation, 'healthy', this.now());
      await this.store.writeOperation(operation);
      complete(operation, 'succeeded', this.now());
      await this.store.writeOperation(operation);
      return operation;
    } catch (err) {
      let failure = normalizeError(err);
      if (switched && installed) {
        transition(operation, 'rolling-back', this.now());
        await this.store.writeOperation(operation);
        try {
          await this.restore(previous, installed, targets, plan.repository);
        } catch (rollbackErr) {
          const rollbackFailure = normalizeError(rollbackErr);
          failure = {
            code: 'UPDATE_AND_ROLLBACK_FAILED',
            message: `${failure.message}; rollback failed: ${rollbackFailure.message}`,
          };
        }
      }
      operation.error = failure;
      complete(operation, 'failed', this.now());
      await this.store.writeOperation(operation);
      throw new Error(failure.message, { cause: err });
    }
  }

  private async rollbackLocked(force: boolean, operationId: string): Promise<UpdateOperationV1> {
    const state = await this.store.readState();
    if (!state.current || !state.previous) throw new Error('no previous Aria version is available for rollback');
    const current = state.current;
    const target = state.previous;
    const operation: UpdateOperationV1 = {
      schemaVersion: UPDATE_OPERATION_SCHEMA_VERSION,
      id: operationId,
      operation: 'rollback',
      planId: null,
      status: 'planned',
      startedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      completedAt: null,
      target: { kind: 'installed', version: target },
      previous: current,
      installed: target,
      error: null,
    };
    await this.store.writeOperation(operation);
    let targets = await this.services.discover();
    let switched = false;
    try {
      await this.services.assertSafe(targets, force);
      await this.installer.smokeTest(target);
      await this.launcher.write();
      transition(operation, 'rolling-back', this.now());
      await this.store.writeOperation(operation);
      await this.store.writeState({ ...state, current: target, previous: current });
      switched = true;
      const spec = this.launcher.launchSpec();
      await this.services.reconcileLaunchers(targets, { runtimePath: spec.runtimePath, entryPath: spec.entryPath });
      transition(operation, 'restarting', this.now());
      await this.store.writeOperation(operation);
      await this.services.restartAndCheck(targets, target.version);
      transition(operation, 'healthy', this.now());
      await this.store.writeOperation(operation);
      complete(operation, 'succeeded', this.now());
      await this.store.writeOperation(operation);
      return operation;
    } catch (err) {
      const failure = normalizeError(err);
      if (switched) {
        try {
          await this.store.writeState({ ...state, current, previous: target });
          const spec = this.launcher.launchSpec();
          targets = await this.services.discover();
          await this.services.reconcileLaunchers(targets, { runtimePath: spec.runtimePath, entryPath: spec.entryPath });
          await this.services.restartAndCheck(targets, current.version);
        } catch (restoreErr) {
          const restoreFailure = normalizeError(restoreErr);
          failure.code = 'ROLLBACK_AND_RESTORE_FAILED';
          failure.message = `${failure.message}; restoring current version failed: ${restoreFailure.message}`;
        }
      }
      operation.error = failure;
      complete(operation, 'failed', this.now());
      await this.store.writeOperation(operation);
      throw new Error(failure.message, { cause: err });
    }
  }

  private async resolveExactRelease(expected: ReleaseDescriptor): Promise<ReleaseDescriptor> {
    const release = (await this.source.list('internal')).find((candidate) => candidate.tag === expected.tag);
    if (!release) throw new Error(`release is no longer available: ${expected.tag}`);
    if (release.repository !== expected.repository || release.version !== expected.version
      || release.commit !== expected.commit || release.publishedAt !== expected.publishedAt
      || JSON.stringify(release.assets) !== JSON.stringify(expected.assets)) {
      throw new Error('release metadata changed after the update plan was created');
    }
    return release;
  }

  private async restore(
    previous: InstalledVersion | null,
    failed: InstalledVersion,
    targets: UpdatePlanV1['services'],
    repository: string,
  ): Promise<void> {
    const state = await this.store.readState({ repository });
    if (previous) await this.installer.smokeTest(previous);
    await this.store.writeState({
      ...state,
      current: previous,
      previous: failed,
      versions: mergeVersions(previous, failed, state.versions),
    });
    if (previous) {
      const spec = this.launcher.launchSpec();
      await this.services.reconcileLaunchers(targets, { runtimePath: spec.runtimePath, entryPath: spec.entryPath });
      await this.services.restartAndCheck(targets, previous.version);
    }
  }

  private async failPendingOperation(operationId: string, err: unknown): Promise<void> {
    try {
      const operation = await this.store.readOperation(operationId);
      if (operation.status === 'failed' || operation.status === 'succeeded') return;
      operation.error = normalizeError(err);
      complete(operation, 'failed', this.now());
      await this.store.writeOperation(operation);
    } catch {
      // The foreground rollback path may fail before an operation is created.
    }
  }
}

function newUpdateOperation(id: string, plan: UpdatePlanV1, now: Date): UpdateOperationV1 {
  return {
    schemaVersion: UPDATE_OPERATION_SCHEMA_VERSION,
    id,
    operation: 'update',
    planId: plan.id,
    status: 'planned',
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
    target: { kind: 'release', release: plan.target },
    previous: null,
    installed: null,
    error: null,
  };
}

function assertPlanFresh(plan: UpdatePlanV1, now: Date): void {
  if (plan.schemaVersion !== UPDATE_PLAN_SCHEMA_VERSION) throw new Error('unsupported update plan schemaVersion');
  if (plan.cancelledAt) throw new Error('update plan was cancelled; create a new plan');
  if (Date.parse(plan.expiresAt) <= now.getTime()) throw new Error('update plan expired; create a new plan');
}

function updatePlanState(plan: UpdatePlanV1, now: Date): 'active' | 'expired' | 'cancelled' {
  if (plan.cancelledAt) return 'cancelled';
  if (Date.parse(plan.expiresAt) <= now.getTime()) return 'expired';
  return 'active';
}

function mergeVersions(
  first: InstalledVersion | null,
  second: InstalledVersion | null,
  rest: InstalledVersion[],
): InstalledVersion[] {
  const values = [first, second, ...rest].filter((value): value is InstalledVersion => Boolean(value));
  return values.filter((value, index) => values.findIndex((candidate) => candidate.sha256 === value.sha256) === index);
}

function transition(operation: UpdateOperationV1, status: UpdateOperationStatus, now: Date): void {
  operation.status = status;
  operation.updatedAt = now.toISOString();
}

function complete(operation: UpdateOperationV1, status: 'succeeded' | 'failed', now: Date): void {
  transition(operation, status, now);
  operation.completedAt = now.toISOString();
}

function normalizeError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) return { code: 'UPDATE_FAILED', message: err.message };
  return { code: 'UPDATE_FAILED', message: String(err) };
}
