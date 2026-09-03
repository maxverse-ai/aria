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
    this.state = { ...this.state, running: true };
    this.timer = setInterval(() => void this.reconcile().catch(() => undefined), this.pollIntervalMs);
    this.timer.unref?.();
    void this.reconcile().catch(() => undefined);
  }

  async close(): Promise<void> {
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

  reconcile(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
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
      if (occurrence.blockedCode !== 'profile-offline') continue;
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
      await this.results?.reconcile().catch((error) =>
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
    while (true) {
      const claimed = await this.store.claimNext({
        now: this.now(),
        leaseId: this.createId(),
        leaseOwner: this.leaseOwner,
        leaseDurationMs: this.leaseDurationMs,
      });
      if (!claimed) return;
      await this.dispatch(claimed);
    }
  }

  private async dispatch(occurrence: TriggerOccurrence): Promise<void> {
    const lease = leaseRef(occurrence);
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
      && ['leased', 'dispatching', 'running'].includes(item.state)).length;
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
    await this.store.beginDispatch(occurrence.id, lease, intentId, this.now());
    let submission;
    try {
      submission = await this.execution.submit(occurrence.profileId, intent);
    } catch (error) {
      await this.fail(occurrence, lease, error, 'trigger-submit-failed');
      await this.resumeOverlap(definition.id);
      return;
    }
    await this.store.markRunning(occurrence.id, lease, submission.runId, this.now());
    this.bump('dispatched');
    this.track(this.observeCompletion(occurrence, lease, submission.completion));
  }

  private async observeCompletion(
    occurrence: TriggerOccurrence,
    lease: TriggerLeaseRef,
    completion: Promise<TriggerExecutionResult>,
  ): Promise<void> {
    try {
      const result = await completion;
      if (result.status === 'succeeded') {
        await this.store.markSucceeded(occurrence.id, lease, this.now());
        this.bump('succeeded');
        // Result delivery is an independent durable workflow. A channel outage
        // must never turn a successful agent occurrence back into agent work.
        const definition = await this.store.getDefinition(occurrence.definitionId);
        if (definition && this.results) {
          await this.results.route(definition, occurrence, result).catch((error) =>
            log.warn('trigger-manager', 'result-route-failed', {
              occurrenceId: occurrence.id,
              code: stableErrorCode(error),
            }));
        }
      } else {
        await this.fail(
          occurrence,
          lease,
          new Error(result.errorCode ?? result.status),
          result.errorCode ?? `run-${result.status}`,
        );
      }
    } catch (error) {
      try {
        await this.fail(occurrence, lease, error, 'run-observation-failed');
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
    if (occurrences.some((item) => ['leased', 'dispatching', 'running'].includes(item.state))) return;
    const queued = occurrences.find((item) => item.state === 'deferred' && item.blockedCode === 'overlap-active');
    if (queued) await this.store.resumeDeferred(queued.id, this.now());
  }

  private track(task: Promise<void>): void {
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
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
