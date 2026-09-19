import { ChannelPluginError } from './plugin/errors';
import { ChannelPluginRegistry } from './plugin/registry';
import type {
  ChannelConfig,
  ChannelDrainOptions,
  ChannelDrainResult,
  ChannelIngressPort,
  ChannelInstanceRef,
  ChannelDeliveryReceipt,
  ChannelOutboundIntent,
  ChannelRuntime,
  ChannelRuntimeState,
  ResolvedChannelInstance,
} from './plugin/types';
import {
  assertChannelDrainOptions,
  channelRuntimeKey,
} from './plugin/validation';

export const CHANNEL_MANAGER_SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_CHANNEL_MANAGER_DRAIN_MS = 25_000;

export type ChannelManagerState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'draining'
  | 'stopped'
  | 'failed';

export type ManagedChannelInstanceState = 'pending' | ChannelRuntimeState;

export interface ChannelManagerStartPlan<
  TConfig extends ChannelConfig = ChannelConfig,
> {
  instance: ResolvedChannelInstance<TConfig>;
  ingress: ChannelIngressPort;
}

export interface ManagedChannelInstanceSnapshot extends ChannelInstanceRef {
  order: number;
  state: ManagedChannelInstanceState;
  acceptingInbound: boolean;
  inFlightInbound: number;
  inFlightOutbound: number;
  updatedAt: number;
  errorCode?: string;
}

export interface ChannelManagerSnapshot {
  schema: 'aria.channel-manager.snapshot.v1';
  version: typeof CHANNEL_MANAGER_SNAPSHOT_VERSION;
  profileId: string;
  state: ChannelManagerState;
  instanceCount: number;
  readyCount: number;
  acceptingInbound: boolean;
  updatedAt: number;
  instances: readonly ManagedChannelInstanceSnapshot[];
}

export interface ChannelManagerDrainFailure extends ChannelInstanceRef {
  code: string;
}

export interface ChannelManagerDrainResult {
  drained: boolean;
  remainingInbound: number;
  remainingOutbound: number;
  failures: readonly ChannelManagerDrainFailure[];
}

export interface ChannelManagerOptions {
  profileId: string;
  registry?: ChannelPluginRegistry;
  drainTimeoutMs?: number;
  now?: () => number;
}

interface ManagedEntry extends ManagedChannelInstanceSnapshot {
  plan: ChannelManagerStartPlan;
  runtime?: ChannelRuntime;
}

/**
 * Profile-owned lifecycle coordinator for channel plugin instances.
 *
 * Stage 3 composes this manager with an empty plan in production. Later stages
 * may supply resolved instances without changing ownership or rollback rules.
 */
export class ChannelManager {
  readonly profileId: string;
  readonly registry: ChannelPluginRegistry;

  private readonly drainTimeoutMs: number;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  private state: ChannelManagerState = 'idle';
  private updatedAt: number;
  private entries: ManagedEntry[] = [];
  private startPromise?: Promise<ChannelManagerSnapshot>;
  private drainPromise?: Promise<ChannelManagerDrainResult>;
  private closePromise?: Promise<void>;
  private drainErrors: unknown[] = [];

  constructor(options: ChannelManagerOptions) {
    if (!options.profileId) {
      throw new Error('channel manager profileId is required');
    }
    if (
      options.drainTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.drainTimeoutMs) || options.drainTimeoutMs <= 0)
    ) {
      throw new Error('channel manager drainTimeoutMs must be a positive integer');
    }
    this.profileId = options.profileId;
    this.registry = options.registry ?? new ChannelPluginRegistry();
    this.drainTimeoutMs =
      options.drainTimeoutMs ?? DEFAULT_CHANNEL_MANAGER_DRAIN_MS;
    this.now = options.now ?? Date.now;
    this.updatedAt = this.now();
  }

  snapshot(): ChannelManagerSnapshot {
    const instances = this.entries.map((entry) => this.snapshotEntry(entry));
    const readyCount = instances.filter((entry) => entry.state === 'ready').length;
    return {
      schema: 'aria.channel-manager.snapshot.v1',
      version: CHANNEL_MANAGER_SNAPSHOT_VERSION,
      profileId: this.profileId,
      state: this.state,
      instanceCount: instances.length,
      readyCount,
      acceptingInbound:
        this.state === 'ready' &&
        instances.length > 0 &&
        instances.every((entry) => entry.acceptingInbound),
      updatedAt: this.updatedAt,
      instances,
    };
  }

  start(plans: readonly ChannelManagerStartPlan[]): Promise<ChannelManagerSnapshot> {
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'idle') {
      return Promise.reject(
        managerError('channel manager cannot start from its current state', {
          kind: 'configuration',
          code: 'invalid-channel-manager-state',
        }),
      );
    }
    this.startPromise = this.startInternal(plans);
    return this.startPromise;
  }

  /** Send through the exact started plugin instance; supports authorized proactive intents. */
  async deliver(intent: ChannelOutboundIntent): Promise<ChannelDeliveryReceipt> {
    const key = channelRuntimeKey(intent);
    const entry = this.entries.find((candidate) => channelRuntimeKey(candidate) === key);
    if (this.state !== 'ready' || !entry?.runtime || entry.runtime.snapshot().state !== 'ready') {
      throw managerError('channel runtime is unavailable for delivery', {
        kind: 'transient',
        code: 'channel-runtime-unavailable',
      });
    }
    return entry.runtime.deliver(intent);
  }

  /**
   * Start one additional instance against the ready manager. The registry
   * start is transactional: a failed start leaves the plan unregistered.
   */
  async addInstance(
    plan: ChannelManagerStartPlan,
  ): Promise<ManagedChannelInstanceSnapshot> {
    this.assertReady();
    const entry = this.newEntry(plan);
    if (this.entries.some((existing) => channelRuntimeKey(existing) === channelRuntimeKey(entry))) {
      throw managerError('duplicate channel instance in manager start plan', {
        kind: 'configuration',
        code: 'duplicate-channel-instance',
      });
    }
    entry.order = this.entries.length;
    this.entries.push(entry);
    try {
      entry.runtime = await this.startEntryRuntime(entry);
      const runtimeSnapshot = entry.runtime.snapshot();
      this.updateEntry(entry, 'ready', {
        acceptingInbound: true,
        inFlightInbound: runtimeSnapshot.inFlightInbound,
        inFlightOutbound: runtimeSnapshot.inFlightOutbound,
      });
      return this.snapshotEntry(entry);
    } catch (error) {
      this.entries = this.entries.filter((candidate) => candidate !== entry);
      this.touch();
      throw error;
    }
  }

  /**
   * Drain and close one instance in place. The entry is removed only after
   * its runtime closed; a drain timeout or close failure keeps it listed so
   * the operation stays retryable.
   */
  async removeInstance(
    ref: ChannelInstanceRef,
    options: ChannelDrainOptions,
  ): Promise<ChannelDrainResult> {
    assertChannelDrainOptions(options);
    const entry = this.entries.find(
      (candidate) => channelRuntimeKey(candidate) === channelRuntimeKey(ref),
    );
    if (!entry || !entry.runtime) {
      if (entry) {
        this.entries = this.entries.filter((candidate) => candidate !== entry);
        this.touch();
      }
      return { drained: true, remainingInbound: 0, remainingOutbound: 0 };
    }
    this.updateEntry(entry, 'draining', { acceptingInbound: false });
    const result = await entry.runtime.drain(options);
    if (!result.drained) {
      entry.inFlightInbound = result.remainingInbound;
      entry.inFlightOutbound = result.remainingOutbound;
      entry.updatedAt = this.touch();
      throw managerError('channel runtime did not drain before its deadline', {
        kind: 'transient',
        code: 'channel-drain-incomplete',
      });
    }
    await entry.runtime.close();
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    this.touch();
    return result;
  }

  /**
   * Replace one running instance: the old owner is drained and closed before
   * the replacement starts (instance keys are unique in the registry). If the
   * replacement fails to start, the previous plan is restarted so rollback
   * restores the previously runnable owner without state conversion.
   */
  async replaceInstance(
    plan: ChannelManagerStartPlan,
    options: ChannelDrainOptions,
  ): Promise<ManagedChannelInstanceSnapshot> {
    this.assertReady();
    const replacement = this.newEntry(plan);
    const key = channelRuntimeKey(replacement);
    const existing = this.entries.find((candidate) => channelRuntimeKey(candidate) === key);
    if (!existing) {
      return this.addInstance(plan);
    }
    const previousPlan = existing.plan;
    const order = existing.order;
    await this.removeInstance(existing, options);
    try {
      replacement.order = order;
      replacement.runtime = await this.startEntryRuntime(replacement);
      this.entries.push(replacement);
      this.entries.sort((a, b) => a.order - b.order);
      const runtimeSnapshot = replacement.runtime.snapshot();
      this.updateEntry(replacement, 'ready', {
        acceptingInbound: true,
        inFlightInbound: runtimeSnapshot.inFlightInbound,
        inFlightOutbound: runtimeSnapshot.inFlightOutbound,
      });
      return this.snapshotEntry(replacement);
    } catch (error) {
      await this.addInstance(previousPlan).catch(() => undefined);
      throw error;
    }
  }

  /** Resolved desired record captured when the instance was started. */
  instanceFor(ref: ChannelInstanceRef): ResolvedChannelInstance | undefined {
    return this.entries.find(
      (candidate) => channelRuntimeKey(candidate) === channelRuntimeKey(ref),
    )?.plan.instance;
  }

  /** Live runtime for one instance; internal only — never leaks to snapshots. */
  runtimeFor(ref: ChannelInstanceRef): ChannelRuntime | undefined {
    return this.entries.find(
      (candidate) => channelRuntimeKey(candidate) === channelRuntimeKey(ref),
    )?.runtime;
  }

  drain(options: ChannelDrainOptions): Promise<ChannelManagerDrainResult> {
    assertChannelDrainOptions(options);
    if (!this.startPromise && this.state === 'idle') {
      return Promise.reject(
        managerError('channel manager cannot drain before start', {
          kind: 'configuration',
          code: 'invalid-channel-manager-state',
        }),
      );
    }
    if (!this.drainPromise) {
      this.drainPromise = this.drainInternal(options);
    }
    return this.drainPromise;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeInternal();
    }
    return this.closePromise;
  }

  private async startInternal(
    plans: readonly ChannelManagerStartPlan[],
  ): Promise<ChannelManagerSnapshot> {
    try {
      this.entries = validatePlans(this.profileId, plans, this.now());
    } catch (error) {
      this.transition('failed');
      throw error;
    }
    this.transition('starting');

    let current: ManagedEntry | undefined;
    try {
      for (const entry of this.entries) {
        if (this.controller.signal.aborted) throw abortError();
        current = entry;
        this.updateEntry(entry, 'starting');
        const runtime = await this.registry.start(entry.pluginId, {
          instance: entry.plan.instance,
          ingress: entry.plan.ingress,
          signal: this.controller.signal,
        });
        entry.runtime = runtime;
        if (this.controller.signal.aborted) throw abortError();
        const runtimeSnapshot = runtime.snapshot();
        if (runtimeSnapshot.state !== 'ready' || !runtimeSnapshot.acceptingInbound) {
          throw managerError('channel runtime did not become ready during start', {
            kind: 'permanent',
            code: 'channel-runtime-not-ready',
          });
        }
        this.updateEntry(entry, 'ready', {
          acceptingInbound: true,
          inFlightInbound: runtimeSnapshot.inFlightInbound,
          inFlightOutbound: runtimeSnapshot.inFlightOutbound,
        });
        current = undefined;
      }
      this.transition('ready');
      return this.snapshot();
    } catch (error) {
      this.controller.abort();
      if (current) {
        this.updateEntry(current, 'failed', {
          acceptingInbound: false,
          errorCode: lifecycleErrorCode(error),
        });
      }
      const rollbackErrors = await this.closeEntries([...this.entries].reverse());
      this.transition('failed');
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'channel manager start failed and rollback was incomplete',
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async drainInternal(
    options: ChannelDrainOptions,
  ): Promise<ChannelManagerDrainResult> {
    await this.startPromise?.catch(() => undefined);
    if (this.state === 'stopped' || this.entries.every((entry) => !entry.runtime)) {
      return emptyDrainResult();
    }

    this.transition('draining');
    let remainingInbound = 0;
    let remainingOutbound = 0;
    const failures: ChannelManagerDrainFailure[] = [];
    this.drainErrors = [];

    for (const entry of [...this.entries].reverse()) {
      if (!entry.runtime) continue;
      this.updateEntry(entry, 'draining', { acceptingInbound: false });
      try {
        const result = await entry.runtime.drain(options);
        remainingInbound += result.remainingInbound;
        remainingOutbound += result.remainingOutbound;
        entry.inFlightInbound = result.remainingInbound;
        entry.inFlightOutbound = result.remainingOutbound;
        entry.updatedAt = this.touch();
        if (!result.drained) {
          const error = managerError('channel runtime did not drain before its deadline', {
            kind: 'transient',
            code: 'channel-drain-incomplete',
          });
          this.drainErrors.push(error);
          failures.push({ ...instanceRef(entry), code: error.code });
        }
      } catch (error) {
        this.drainErrors.push(error);
        this.updateEntry(entry, 'failed', {
          acceptingInbound: false,
          errorCode: lifecycleErrorCode(error),
        });
        failures.push({ ...instanceRef(entry), code: lifecycleErrorCode(error) });
      }
    }

    return {
      drained:
        failures.length === 0 &&
        remainingInbound === 0 &&
        remainingOutbound === 0,
      remainingInbound,
      remainingOutbound,
      failures,
    };
  }

  private async closeInternal(): Promise<void> {
    this.controller.abort();
    await this.startPromise?.catch(() => undefined);
    if (this.state === 'idle') {
      this.transition('stopped');
      return;
    }

    const drain = await this.drain({
      deadlineAt: this.now() + this.drainTimeoutMs,
    });
    const closeErrors = await this.closeEntries([...this.entries].reverse());
    const failures = [...this.drainErrors, ...closeErrors];
    if (!drain.drained && failures.length === 0) {
      failures.push(
        managerError('one or more channel runtimes did not drain', {
          kind: 'transient',
          code: 'channel-drain-incomplete',
        }),
      );
    }
    this.transition(failures.length > 0 ? 'failed' : 'stopped');
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more channel runtimes failed to stop');
    }
  }

  private async closeEntries(entries: readonly ManagedEntry[]): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const entry of entries) {
      if (!entry.runtime) continue;
      try {
        await entry.runtime.close();
        this.updateEntry(entry, 'stopped', {
          acceptingInbound: false,
          inFlightInbound: 0,
          inFlightOutbound: 0,
        });
      } catch (error) {
        failures.push(error);
        this.updateEntry(entry, 'failed', {
          acceptingInbound: false,
          errorCode: lifecycleErrorCode(error),
        });
      } finally {
        entry.runtime = undefined;
      }
    }
    return failures;
  }

  private snapshotEntry(entry: ManagedEntry): ManagedChannelInstanceSnapshot {
    if (this.state === 'ready' && entry.runtime) {
      try {
        const runtime = entry.runtime.snapshot();
        return {
          ...instanceRef(entry),
          order: entry.order,
          state: runtime.state,
          acceptingInbound: runtime.acceptingInbound,
          inFlightInbound: runtime.inFlightInbound,
          inFlightOutbound: runtime.inFlightOutbound,
          updatedAt: runtime.updatedAt,
          ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
        };
      } catch (error) {
        return {
          ...instanceRef(entry),
          order: entry.order,
          state: 'failed',
          acceptingInbound: false,
          inFlightInbound: entry.inFlightInbound,
          inFlightOutbound: entry.inFlightOutbound,
          updatedAt: this.updatedAt,
          errorCode: lifecycleErrorCode(error),
        };
      }
    }
    return {
      ...instanceRef(entry),
      order: entry.order,
      state: entry.state,
      acceptingInbound: entry.acceptingInbound,
      inFlightInbound: entry.inFlightInbound,
      inFlightOutbound: entry.inFlightOutbound,
      updatedAt: entry.updatedAt,
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    };
  }

  private assertReady(): void {
    if (this.state !== 'ready') {
      throw managerError('channel manager cannot mutate instances outside ready state', {
        kind: 'configuration',
        code: 'invalid-channel-manager-state',
      });
    }
  }

  private newEntry(plan: ChannelManagerStartPlan): ManagedEntry {
    const entry = validatePlans(this.profileId, [plan], this.now()).at(0);
    if (!entry) {
      throw managerError('channel manager start plan produced no entry', {
        kind: 'configuration',
        code: 'invalid-channel-start-plan',
      });
    }
    return entry;
  }

  /** Registry start + readiness check shared by add/replace and initial start. */
  private async startEntryRuntime(entry: ManagedEntry): Promise<ChannelRuntime> {
    this.updateEntry(entry, 'starting');
    const runtime = await this.registry.start(entry.pluginId, {
      instance: entry.plan.instance,
      ingress: entry.plan.ingress,
      signal: this.controller.signal,
    });
    const runtimeSnapshot = runtime.snapshot();
    if (runtimeSnapshot.state !== 'ready' || !runtimeSnapshot.acceptingInbound) {
      await runtime.close().catch(() => undefined);
      throw managerError('channel runtime did not become ready during start', {
        kind: 'permanent',
        code: 'channel-runtime-not-ready',
      });
    }
    return runtime;
  }

  private transition(state: ChannelManagerState): void {
    this.state = state;
    this.updatedAt = this.touch();
  }

  private updateEntry(
    entry: ManagedEntry,
    state: ManagedChannelInstanceState,
    patch: Partial<ManagedChannelInstanceSnapshot> = {},
  ): void {
    Object.assign(entry, patch, { state, updatedAt: this.touch() });
  }

  private touch(): number {
    const value = this.now();
    this.updatedAt = value;
    return value;
  }
}

function validatePlans(
  profileId: string,
  plans: readonly ChannelManagerStartPlan[],
  now: number,
): ManagedEntry[] {
  const keys = new Set<string>();
  return plans.map((plan, order) => {
    if (plan.instance.profileId !== profileId) {
      throw managerError('channel instance belongs to another profile', {
        kind: 'configuration',
        code: 'channel-profile-mismatch',
      });
    }
    const key = channelRuntimeKey(plan.instance);
    if (keys.has(key)) {
      throw managerError('duplicate channel instance in manager start plan', {
        kind: 'configuration',
        code: 'duplicate-channel-instance',
      });
    }
    keys.add(key);
    return {
      ...instanceRef(plan.instance),
      order,
      state: 'pending' as const,
      acceptingInbound: false,
      inFlightInbound: 0,
      inFlightOutbound: 0,
      updatedAt: now,
      plan,
    };
  });
}

function instanceRef(value: ChannelInstanceRef): ChannelInstanceRef {
  return {
    profileId: value.profileId,
    pluginId: value.pluginId,
    instanceId: value.instanceId,
  };
}

function lifecycleErrorCode(error: unknown): string {
  if (error instanceof ChannelPluginError) return error.code;
  if (error instanceof Error && error.name === 'AbortError') {
    return 'channel-start-aborted';
  }
  return 'channel-lifecycle-failed';
}

function managerError(
  message: string,
  options: ConstructorParameters<typeof ChannelPluginError>[1],
): ChannelPluginError {
  return new ChannelPluginError(message, options);
}

function abortError(): Error {
  const error = new Error('channel manager start aborted');
  error.name = 'AbortError';
  return error;
}

function emptyDrainResult(): ChannelManagerDrainResult {
  return {
    drained: true,
    remainingInbound: 0,
    remainingOutbound: 0,
    failures: [],
  };
}
