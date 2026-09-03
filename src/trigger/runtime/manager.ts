import { randomUUID } from 'node:crypto';
import { log } from '../../core/logger';
import { materializeDueTimes, type ScheduleSpec } from '../schedule';
import {
  createPendingOccurrence,
  type TriggerDefinition,
  type TriggerFailureKind,
  type TriggerLeaseRef,
  type TriggerOccurrence,
  type TriggerStateStore,
} from '../state';
import { createTriggerRunIntent } from './intent';
import type { TriggerExecutionGateway, TriggerManagerSnapshot } from './types';

export interface TriggerManagerOptions {
  enabled?: boolean;
  store: TriggerStateStore;
  execution: TriggerExecutionGateway;
  now?: () => number;
  createId?: () => string;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  leaseOwner?: string;
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_LEASE_MS = 30 * 60_000;

/** Host-owned single-process coordinator. Durable state remains authoritative. */
export class TriggerManager {
  private readonly enabled: boolean;
  private readonly store: TriggerStateStore;
  private readonly execution: TriggerExecutionGateway;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly leaseOwner: string;
  private timer?: ReturnType<typeof setInterval>;
  private reconcilePromise?: Promise<void>;
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
    this.state = {
      enabled: this.enabled,
      running: false,
      reconciling: false,
      materialized: 0,
      dispatched: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
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

  private async performReconcile(): Promise<void> {
    const now = this.now();
    this.state = { ...this.state, lastScanAt: now, lastErrorCode: undefined };
    try {
      await this.materializeOneTimeDue(now);
      await this.dispatchClaimable();
    } catch (error) {
      const code = stableErrorCode(error);
      this.state = { ...this.state, lastErrorCode: code };
      log.warn('trigger-manager', 'reconcile-failed', { code });
      throw error;
    }
  }

  private async materializeOneTimeDue(now: number): Promise<void> {
    const definitions = await this.store.listDefinitions({ state: 'active' });
    for (const definition of definitions) {
      if (definition.sourceKind !== 'schedule' || definition.nextFireAt === undefined) continue;
      const spec = scheduleContract(definition);
      if (spec.schedule.kind !== 'once' || definition.nextFireAt > now) continue;
      const due = materializeDueTimes({
        spec: spec.schedule,
        timeZone: spec.timeZone,
        nextFireAt: definition.nextFireAt,
        now,
        misfirePolicy: definition.misfirePolicy,
      });
      if (due.due.length === 0) {
        await this.advanceWithoutOccurrence(definition, due.nextFireAt, now);
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
    }
  }

  private async advanceWithoutOccurrence(
    definition: TriggerDefinition,
    nextFireAt: number | undefined,
    now: number,
  ): Promise<void> {
    await this.store.replaceDefinition({
      ...definition,
      revision: definition.revision + 1,
      nextFireAt,
      scheduleAdvancedAt: now,
      updatedAt: now,
    }, definition.revision);
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
    if (!historyOnly(definition)) {
      await this.dead(occurrence, lease, 'unsupported-capability', 'result-route-unsupported');
      return;
    }
    if (!this.execution.isProfileOnline(occurrence.profileId)) {
      await this.store.markDeferred(occurrence.id, lease, 'profile-offline', this.now());
      this.bump('deferred');
      return;
    }

    const intentId = occurrence.dispatch?.intentId ?? this.createId();
    const intent = createTriggerRunIntent(definition, occurrence, intentId);
    await this.store.beginDispatch(occurrence.id, lease, intentId, this.now());
    let submission;
    try {
      submission = await this.execution.submit(occurrence.profileId, intent);
    } catch (error) {
      await this.fail(occurrence, lease, error, 'trigger-submit-failed');
      return;
    }
    await this.store.markRunning(occurrence.id, lease, submission.runId, this.now());
    this.bump('dispatched');
    try {
      const result = await submission.completion;
      if (result.status === 'succeeded') {
        await this.store.markSucceeded(occurrence.id, lease, this.now());
        this.bump('succeeded');
      } else {
        await this.fail(
          occurrence,
          lease,
          new Error(result.errorCode ?? result.status),
          result.errorCode ?? `run-${result.status}`,
        );
      }
    } catch (error) {
      await this.fail(occurrence, lease, error, 'run-observation-failed');
    }
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

  private bump(field: 'materialized' | 'dispatched' | 'succeeded' | 'failed' | 'deferred'): void {
    this.state = { ...this.state, [field]: this.state[field] + 1 };
  }
}

function scheduleContract(definition: TriggerDefinition): { schedule: ScheduleSpec; timeZone: string } {
  return definition.triggerSpec as unknown as { schedule: ScheduleSpec; timeZone: string };
}

function historyOnly(definition: TriggerDefinition): boolean {
  return definition.intentTemplate.resultRoutes.every((route) =>
    route.kind === 'history' || route.kind === 'none'
      || (route.kind === 'multi' && route.routes.every((leaf) => leaf.kind === 'history' || leaf.kind === 'none')),
  );
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
