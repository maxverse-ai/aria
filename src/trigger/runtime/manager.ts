import { randomUUID } from 'node:crypto';
import { log } from '../../core/logger';
import { decideOverlap, materializeDueTimes, type ScheduleSpec } from '../schedule';
import {
  TriggerStateError,
  createPendingOccurrence,
  type TriggerDefinition,
  type TriggerFailureKind,
  type TriggerLeaseRef,
  type TriggerOccurrence,
  type TriggerStateStore,
} from '../state';
import { createTriggerRunIntent } from './intent';
import type { TriggerExecutionGateway, TriggerExecutionResult, TriggerManagerSnapshot } from './types';
import { TriggerExecutionNotAcceptedError } from './types';
import type { TriggerResultGateway } from '../result';

export interface TriggerManagerOptions {
  enabled?: boolean;
  store: TriggerStateStore;
  execution: TriggerExecutionGateway;
  now?: () => number;
  createId?: () => string;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  leaseOwner?: string;
  results?: TriggerResultGateway;
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_LEASE_MS = 30 * 60_000;
const DEFAULT_DRAIN_MS = 30_000;

/** Host-owned clock and dispatcher. Durable state, not process timers, is authoritative. */
export class TriggerManager {
  private readonly enabled: boolean;
  private readonly store: TriggerStateStore;
  private readonly execution: TriggerExecutionGateway;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly leaseOwner: string;
  private readonly results?: TriggerResultGateway;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly routing = new Set<string>();
  private readonly admissionHolds = new Map<string, number>();
  private readonly profileTasks = new Map<string, Set<Promise<void>>>();
  private closing = false;
  private timer?: ReturnType<typeof setInterval>;
  private reconcilePromise?: Promise<void>;
  private lastObservedNow?: number;
  private state: TriggerManagerSnapshot;

  constructor(options: TriggerManagerOptions) {
    this.enabled = options.enabled === true;
    this.store = options.store;
    this.execution = options.execution;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.pollIntervalMs = positive(options.pollIntervalMs ?? DEFAULT_POLL_MS, 'poll interval');
    this.leaseDurationMs = positive(options.leaseDurationMs ?? DEFAULT_LEASE_MS, 'lease duration');
    this.leaseOwner = options.leaseOwner ?? `supervisor:${process.pid}`;
    this.results = options.results;
    this.state = {
      enabled: this.enabled,
      running: false,
      reconciling: false,
      materialized: 0,
      dispatched: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      skipped: 0,
      coalesced: 0,
      clockJumps: 0,
    };
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.closing = false;
    this.state = { ...this.state, running: true };
    this.timer = setInterval(() => void this.reconcile().catch(() => undefined), this.pollIntervalMs);
    this.timer.unref?.();
    void this.reconcile().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.state = { ...this.state, running: false };
    await this.reconcilePromise?.catch(() => undefined);
    await this.drain(DEFAULT_DRAIN_MS);
  }

  /** Wait for already submitted agent runs without stopping future reconciliation. */
  async drain(timeoutMs = DEFAULT_DRAIN_MS): Promise<void> {
    positive(timeoutMs, 'drain timeout');
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await Promise.race([Promise.allSettled([...this.inFlight]), delay(remaining)]);
      if (Date.now() >= deadline) return;
    }
  }

  snapshot(): TriggerManagerSnapshot {
    return { ...this.state };
  }

  /** Install before awaiting drain, so no later dispatch may cross submission. */
  pauseProfileAdmission(profileId: string): () => void {
    this.admissionHolds.set(profileId, (this.admissionHolds.get(profileId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const depth = (this.admissionHolds.get(profileId) ?? 1) - 1;
      if (depth > 0) this.admissionHolds.set(profileId, depth);
      else {
        this.admissionHolds.delete(profileId);
        void this.resumeProfile(profileId).then(() => this.reconcile()).catch(() => undefined);
      }
    };
  }

  async waitProfileIdle(profileId: string, timeoutMs: number): Promise<void> {
    positive(timeoutMs, 'profile drain timeout');
    if (!this.admissionHolds.has(profileId)) throw new Error('profile admission must be paused before drain');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = [...(this.profileTasks.get(profileId) ?? [])];
      if (this.reconcilePromise) tasks.push(this.reconcilePromise);
      if (!tasks.length) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('trigger-profile-drain-timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(tasks),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('trigger-profile-drain-timeout')), remaining); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    }
  }

  reconcile(): Promise<void> {
    if (!this.enabled || this.closing) return Promise.resolve();
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.performReconcile().finally(() => {
      this.state = { ...this.state, reconciling: false };
      this.reconcilePromise = undefined;
    });
    this.state = { ...this.state, reconciling: true };
    return this.reconcilePromise;
  }

  /** Reconsider work that was durably deferred while one profile was stopped. */
  async resumeProfile(profileId: string): Promise<number> {
    if (!this.enabled) return 0;
    const deferred = await this.store.listOccurrences({ profileId, state: 'deferred' });
    let resumed = 0;
    for (const occurrence of deferred) {
      if (this.admissionHolds.has(profileId)) return resumed;
      if (!['profile-offline', 'profile-updating'].includes(occurrence.blockedCode ?? '')) continue;
      await this.store.resumeDeferred(occurrence.id, this.now());
      resumed += 1;
    }
    if (resumed > 0) await this.reconcile();
    return resumed;
  }

  private async performReconcile(): Promise<void> {
    const now = this.now();
    if (this.lastObservedNow !== undefined
      && (now < this.lastObservedNow || now - this.lastObservedNow > this.pollIntervalMs * 2)) {
      this.bump('clockJumps');
    }
    this.lastObservedNow = now;
    this.state = { ...this.state, lastScanAt: now, lastErrorCode: undefined };
    try {
      await this.materializeDueSchedules(now);
      // Operator resolution may happen while no local completion observer
      // exists. Revisit durable overlap queues on every normal scan.
      const queued = await this.store.listOccurrences({ state: 'deferred' });
      for (const definitionId of new Set(queued.filter(item => item.blockedCode === 'overlap-active').map(item => item.definitionId))) {
        await this.resumeOverlap(definitionId);
      }
      await this.routePendingResults();
      if (!this.admissionHolds.size) await this.results?.reconcile().catch((error) =>
        log.warn('trigger-manager', 'result-reconcile-failed', {
          code: stableErrorCode(error),
        }));
      await this.dispatchClaimable();
    } catch (error) {
      const code = stableErrorCode(error);
      this.state = { ...this.state, lastErrorCode: code };
      log.warn('trigger-manager', 'reconcile-failed', { code });
      throw error;
    }
  }

  private async materializeDueSchedules(now: number): Promise<void> {
    const definitions = await this.store.listDefinitions({ state: 'active' });
    for (const definition of definitions) {
      if (definition.sourceKind !== 'schedule' || definition.nextFireAt === undefined
        || definition.nextFireAt > now) continue;
      const spec = scheduleContract(definition);
      const due = materializeDueTimes({
        spec: spec.schedule,
        timeZone: spec.timeZone,
        nextFireAt: definition.nextFireAt,
        now,
        misfirePolicy: definition.misfirePolicy,
      });
      this.recordMisfires(definition, due.skipped, due.truncated);
      try {
        if (due.due.length === 0) {
          await this.store.advanceSchedule({
            definitionId: definition.id,
            expectedRevision: definition.revision,
            expectedNextFireAt: definition.nextFireAt,
            nextFireAt: due.nextFireAt,
            advancedAt: now,
          });
          continue;
        }
        const scheduledFor = due.due[0]!;
        const occurrence = createPendingOccurrence({
          id: this.createId(),
          profileId: definition.profileId,
          definitionId: definition.id,
          definitionRevision: definition.revision,
          scheduledFor,
          createdAt: now,
          metadata: { providerId: definition.providerId },
        });
        const result = await this.store.materialize({
          definitionId: definition.id,
          expectedRevision: definition.revision,
          expectedNextFireAt: definition.nextFireAt,
          occurrence,
          nextFireAt: due.nextFireAt,
          advancedAt: now,
        });
        if (result.status === 'created') this.bump('materialized');
      } catch (error) {
        // Multiple hosts may race; the durable cursor CAS chooses one winner.
        if (!(error instanceof TriggerStateError) || error.code !== 'revision-conflict') throw error;
      }
    }
  }

  private recordMisfires(definition: TriggerDefinition, count: number, truncated: boolean): void {
    if (count === 0) return;
    if (definition.misfirePolicy === 'coalesce' && !truncated) this.add('coalesced', count);
    else this.add('skipped', count);
  }

  private async dispatchClaimable(): Promise<void> {
    while (!this.closing) {
      const claimed = await this.store.claimNext({
        now: this.now(),
        leaseId: this.createId(),
        leaseOwner: this.leaseOwner,
        leaseDurationMs: this.leaseDurationMs,
      });
      if (!claimed) return;
      const task = this.dispatch(claimed);
      this.trackProfile(claimed.profileId, task);
      await task;
    }
  }

  private async dispatch(occurrence: TriggerOccurrence): Promise<void> {
    const lease = leaseRef(occurrence);
    if (this.admissionHolds.has(occurrence.profileId) && !['running', 'dispatching'].includes(occurrence.state)) {
      await this.store.markDeferred(occurrence.id, lease, 'profile-updating', this.now());
      this.bump('deferred');
      return;
    }
    if (occurrence.state === 'running' || occurrence.state === 'dispatching') {
      // We no longer have a trustworthy observer of remote acceptance/completion.
      // Retain the dispatch identity; never turn an expired lease into new execution.
      await this.store.markDeferred(occurrence.id, lease, 'execution-outcome-unknown', this.now());
      this.bump('deferred');
      return;
    }
    const definition = await this.store.getDefinition(occurrence.definitionId);
    if (!definition || definition.state === 'canceled') {
      await this.dead(occurrence, lease, 'canceled', 'definition-canceled');
      return;
    }
    if (definition.revision !== occurrence.definitionRevision) {
      await this.dead(occurrence, lease, 'configuration', 'definition-revision-changed');
      return;
    }
    if (!this.execution.isProfileOnline(occurrence.profileId)) {
      await this.store.markDeferred(occurrence.id, lease, 'profile-offline', this.now());
      this.bump('deferred');
      return;
    }

    const siblings = await this.store.listOccurrences({ definitionId: definition.id });
    const activeCount = siblings.filter((item) => item.id !== occurrence.id
      && occupiesExecution(item)).length;
    const queuedCount = siblings.filter((item) => item.state === 'deferred'
      && item.blockedCode === 'overlap-active').length;
    const quotaReached = activeCount >= definition.quota.maxActiveOccurrences;
    const decision = quotaReached ? 'skip' : decideOverlap({
      policy: definition.overlapPolicy,
      activeCount,
      queuedCount,
    });
    if (decision === 'queue') {
      await this.store.markDeferred(occurrence.id, lease, 'overlap-active', this.now());
      this.bump('deferred');
      return;
    }
    if (decision === 'skip') {
      await this.store.markSkipped(
        occurrence.id,
        lease,
        quotaReached ? 'active-quota-exceeded' : 'overlap-skipped',
        this.now(),
      );
      this.bump('skipped');
      return;
    }

    const extendedExpiry = this.now() + definition.authorizationCeiling.maxRuntimeMs + this.leaseDurationMs;
    await this.store.renewLease(occurrence.id, lease, this.now(), extendedExpiry);
    const intentId = occurrence.dispatch?.intentId ?? this.createId();
    const intent = createTriggerRunIntent(definition, occurrence, intentId);
    try {
      await this.store.beginDispatch(occurrence.id, lease, intentId, this.now());
    } catch (error) {
      if (error instanceof TriggerStateError && error.code === 'daily-quota-exceeded') {
        await this.store.markSkipped(occurrence.id, lease, 'daily-quota-exceeded', this.now());
        this.bump('skipped');
        return;
      }
      throw error;
    }
    let submission;
    if (this.admissionHolds.has(occurrence.profileId)) {
      await this.store.markDeferred(occurrence.id, lease, 'profile-updating', this.now());
      this.bump('deferred');
      return;
    }
    try {
      submission = await this.execution.submit(occurrence.profileId, intent);
    } catch (error) {
      if (error instanceof TriggerExecutionNotAcceptedError) await this.fail(occurrence, lease, error, 'trigger-submit-failed');
      else {
        await this.store.markDeferred(occurrence.id, lease, 'execution-outcome-unknown', this.now());
        this.bump('deferred');
      }
      await this.resumeOverlap(definition.id);
      return;
    }
    // Observe immediately: persistence failure after accepted submission must
    // not leave a rejecting completion promise unhandled.
    void submission.completion.catch(() => undefined);
    try {
      await this.store.markRunning(occurrence.id, lease, submission.runId, this.now());
    } catch (error) {
      log.warn('trigger-manager', 'accepted-checkpoint-uncertain', { occurrenceId: occurrence.id, code: stableErrorCode(error) });
      await this.store.markDeferred(occurrence.id, lease, 'execution-outcome-unknown', this.now()).catch(() => undefined);
      const settlement = submission.completion.then(() => undefined, () => undefined);
      this.trackProfile(occurrence.profileId, settlement);
      this.track(settlement);
      return;
    }
    this.bump('dispatched');
    const observation = this.observeCompletion(occurrence, lease, submission.completion);
    this.trackProfile(occurrence.profileId, observation);
    this.track(observation);
  }

  private async observeCompletion(
    occurrence: TriggerOccurrence,
    lease: TriggerLeaseRef,
    completion: Promise<TriggerExecutionResult>,
  ): Promise<void> {
    let observedSuccess = false;
    try {
      const result = await completion;
      if (result.status === 'succeeded') {
        observedSuccess = true;
        await this.store.markSucceeded(occurrence.id, lease, this.now(), result.output?.text ? { text: result.output.text } : undefined);
        this.bump('succeeded');
        // Result delivery is an independent durable workflow. A channel outage
        // must never turn a successful agent occurrence back into agent work.
        await this.routePendingResults();
      } else {
        await this.fail(
          occurrence,
          lease,
          new Error(result.errorCode ?? result.status),
          result.errorCode ?? `run-${result.status}`,
        );
      }
    } catch (error) {
      if (observedSuccess) {
        // The external work succeeded. A failed local checkpoint is never
        // evidence that replaying those side effects would be safe.
        log.warn('trigger-manager', 'success-checkpoint-uncertain', {
          occurrenceId: occurrence.id, code: stableErrorCode(error),
        });
        return;
      }
      try {
        await this.store.markDeferred(occurrence.id, lease, 'execution-outcome-unknown', this.now());
        this.bump('deferred');
      } catch (stateError) {
        log.warn('trigger-manager', 'completion-persist-failed', {
          occurrenceId: occurrence.id,
          code: stableErrorCode(stateError),
        });
      }
    } finally {
      await this.resumeOverlap(occurrence.definitionId).catch((error) =>
        log.warn('trigger-manager', 'overlap-resume-failed', {
          occurrenceId: occurrence.id,
          code: stableErrorCode(error),
        }));
      await this.reconcile().catch(() => undefined);
    }
  }

  private async resumeOverlap(definitionId: string): Promise<void> {
    const occurrences = await this.store.listOccurrences({ definitionId });
    if (occurrences.some(occupiesExecution)) return;
    const queued = occurrences.find((item) => item.state === 'deferred' && item.blockedCode === 'overlap-active');
    if (queued) await this.store.resumeDeferred(queued.id, this.now());
  }

  private async routePendingResults(): Promise<void> {
    if (!this.results) return;
    for (const occurrence of await this.store.listOccurrences({ state: 'succeeded' })) {
      if (!occurrence.resultOutbox || this.routing.has(occurrence.id) || this.admissionHolds.has(occurrence.profileId)) continue;
      this.routing.add(occurrence.id);
      try {
        const outbox = occurrence.resultOutbox;
        await this.results.route(outbox.definition, occurrence, { status: 'succeeded', output: { text: outbox.text } });
        await this.store.acknowledgeResult(occurrence.id);
      } catch (error) {
        log.warn('trigger-manager', 'result-route-failed', { occurrenceId: occurrence.id, code: stableErrorCode(error) });
      } finally { this.routing.delete(occurrence.id); }
    }
  }

  private track(task: Promise<void>): void {
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  private trackProfile(profileId: string, task: Promise<void>): void {
    let tasks = this.profileTasks.get(profileId);
    if (!tasks) { tasks = new Set(); this.profileTasks.set(profileId, tasks); }
    tasks.add(task);
    const settled = () => { tasks.delete(task); if (!tasks.size) this.profileTasks.delete(profileId); };
    void task.then(settled, settled);
  }

  private async fail(
    occurrence: TriggerOccurrence,
    lease: TriggerLeaseRef,
    error: unknown,
    fallbackCode: string,
  ): Promise<void> {
    await this.store.scheduleRetry({
      occurrenceId: occurrence.id,
      lease,
      failure: {
        kind: 'transient',
        code: normalizeCode(error, fallbackCode),
        recordedAt: this.now(),
      },
      now: this.now(),
    });
    this.bump('failed');
  }

  private async dead(
    occurrence: TriggerOccurrence,
    lease: TriggerLeaseRef,
    kind: TriggerFailureKind,
    code: string,
  ): Promise<void> {
    await this.store.markDead(occurrence.id, lease, {
      kind,
      code,
      recordedAt: this.now(),
    }, this.now());
    this.bump('failed');
  }

  private bump(field: Counter): void {
    this.add(field, 1);
  }

  private add(field: Counter, count: number): void {
    this.state = { ...this.state, [field]: this.state[field] + count };
  }
}

type Counter = 'materialized' | 'dispatched' | 'succeeded' | 'failed' | 'deferred' | 'skipped' | 'coalesced' | 'clockJumps';

function scheduleContract(definition: TriggerDefinition): { schedule: ScheduleSpec; timeZone: string } {
  return definition.triggerSpec as unknown as { schedule: ScheduleSpec; timeZone: string };
}

function leaseRef(occurrence: TriggerOccurrence): TriggerLeaseRef {
  if (!occurrence.lease) throw new Error('claimed occurrence is missing a lease');
  return { leaseId: occurrence.lease.leaseId, token: occurrence.lease.token };
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function stableErrorCode(error: unknown): string {
  return normalizeCode(error, 'trigger-manager-error');
}

function normalizeCode(error: unknown, fallback: string): string {
  const candidate = error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : fallback;
  const normalized = candidate.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 128);
  return /^[a-z]/.test(normalized) ? normalized : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function occupiesExecution(occurrence: TriggerOccurrence): boolean {
  return ['leased', 'dispatching', 'running'].includes(occurrence.state)
    || (occurrence.state === 'deferred' && occurrence.blockedCode === 'execution-outcome-unknown');
}
