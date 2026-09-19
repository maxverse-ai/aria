import { ChannelManager, type ChannelManagerSnapshot } from '../channel/manager';
import { ChannelPluginError } from '../channel/plugin/errors';
import {
  ExternalChannelPluginLoader,
  type ExternalChannelPluginRequest,
  type LoadedExternalChannelPlugin,
} from '../channel/plugin/loader';
import { ChannelPluginRegistry } from '../channel/plugin/registry';
import type {
  ChannelDrainOptions,
  ChannelIngressPort,
  ChannelInstanceRef,
  ResolvedChannelInstance,
} from '../channel/plugin/types';
import type { PreparedSpaceProfile } from '../space/profile';
import type { ExternalChannelPluginComposition } from './external-channel-runtime';

const DEFAULT_OPERATION_DEADLINE_MS = 5_000;

export type ChannelAdminOperation =
  | 'load-package'
  | 'start'
  | 'stop'
  | 'restart'
  | 'reconnect'
  | 'login'
  | 'logout'
  | 'unload-package';

export interface ChannelReconcileOutcome {
  operation: ChannelAdminOperation;
  status: 'applied' | 'skipped' | 'failed';
  instanceId?: string;
  pluginId?: string;
  /** Stable diagnostic code; never carries provider payloads or secrets. */
  code?: string;
}

export interface ChannelReconcileReport {
  profile: string;
  status: 'applied' | 'partial' | 'failed';
  outcomes: readonly ChannelReconcileOutcome[];
}

export interface ChannelRuntimeAdminOptions {
  profileId: string;
  composition: ExternalChannelPluginComposition;
  spaces?: PreparedSpaceProfile;
  /** Bounded drain window applied to stop/restart operations. */
  deadlineMs?: number;
  now?: () => number;
}

export interface ChannelRuntimeAdminSnapshot {
  profileId: string;
  loadedPlugins: readonly LoadedExternalChannelPlugin[];
  manager: ChannelManagerSnapshot;
}

export interface ChannelReconcileInput {
  requests: readonly ExternalChannelPluginRequest[];
  instances: readonly ResolvedChannelInstance[];
}

function keyOf(ref: ChannelInstanceRef): string {
  return `${ref.pluginId}/${ref.instanceId}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameInstance(
  left: ResolvedChannelInstance | undefined,
  right: ResolvedChannelInstance | undefined,
): boolean {
  if (!left || !right) return false;
  return stableJson(left) === stableJson(right);
}

function errorCode(error: unknown): string {
  if (error instanceof ChannelPluginError) return error.code;
  return 'channel-admin-operation-failed';
}

/**
 * Channel-grained runtime reconciliation for one profile.
 *
 * Converges the external channel runtime toward already-committed desired
 * state: loads trusted+declared packages, starts/stops/replaces instances,
 * consumes provider-neutral auth intents, and unloads packages that are no
 * longer needed. Every operation is idempotent and retryable: outcomes carry
 * stable codes, a failed start cleans up its half-registered plan, and a
 * restart keeps the previously runnable owner until the replacement is ready.
 *
 * The admin never writes desired state, never installs packages, and never
 * resolves secrets — credential and configuration boundaries stay outside.
 */
export class ChannelRuntimeAdmin {
  private readonly registry: ChannelPluginRegistry;
  private readonly loader: ExternalChannelPluginLoader;
  private readonly manager: ChannelManager;
  private readonly options: ChannelRuntimeAdminOptions;
  private readonly consumedAuth = new Map<string, string>();
  private closePromise: Promise<void> | undefined;

  private constructor(options: ChannelRuntimeAdminOptions) {
    this.options = options;
    this.registry = new ChannelPluginRegistry();
    this.loader = new ExternalChannelPluginLoader({
      registry: this.registry,
      trustedPackages: options.composition.trustedPackages,
      ...(options.composition.source ? { source: options.composition.source } : {}),
    });
    this.manager = new ChannelManager({ profileId: options.profileId, registry: this.registry });
  }

  /** Start with an empty ready manager; desired state is applied via reconcile. */
  static async start(options: ChannelRuntimeAdminOptions): Promise<ChannelRuntimeAdmin> {
    const admin = new ChannelRuntimeAdmin(options);
    try {
      await admin.manager.start([]);
      return admin;
    } catch (error) {
      await admin.manager.close().catch(() => undefined);
      throw error;
    }
  }

  snapshot(): ChannelRuntimeAdminSnapshot {
    return {
      profileId: this.options.profileId,
      loadedPlugins: this.loader.list(),
      manager: this.manager.snapshot(),
    };
  }

  /** Start one enabled instance; a failed start removes the half-registered plan. */
  async startInstance(instance: ResolvedChannelInstance): Promise<ChannelReconcileOutcome> {
    const base = { operation: 'start' as const, instanceId: instance.instanceId, pluginId: instance.pluginId };
    try {
      if (this.manager.instanceFor(instance)) return { ...base, status: 'skipped' };
      await this.manager.addInstance({ instance, ingress: this.createIngress(instance) });
      return { ...base, status: 'applied' };
    } catch (error) {
      return { ...base, status: 'failed', code: errorCode(error) };
    }
  }

  /** Bounded drain + close for one instance. In-flight work fails fast, retryable. */
  async stopInstance(ref: ChannelInstanceRef): Promise<ChannelReconcileOutcome> {
    const base = { operation: 'stop' as const, instanceId: ref.instanceId, pluginId: ref.pluginId };
    try {
      const managed = this.managedEntry(ref);
      if (!managed) return { ...base, status: 'skipped' };
      if (managed.inFlightInbound > 0 || managed.inFlightOutbound > 0) {
        return { ...base, status: 'failed', code: 'channel-activity-in-flight' };
      }
      await this.manager.removeInstance(ref, this.deadline());
      this.consumedAuth.delete(keyOf(ref));
      return { ...base, status: 'applied' };
    } catch (error) {
      return { ...base, status: 'failed', code: errorCode(error) };
    }
  }

  /** Replace a running instance; the old owner survives a failed replacement start. */
  async restartInstance(instance: ResolvedChannelInstance): Promise<ChannelReconcileOutcome> {
    const base = { operation: 'restart' as const, instanceId: instance.instanceId, pluginId: instance.pluginId };
    try {
      const managed = this.managedEntry(instance);
      if (!managed) {
        await this.manager.addInstance({ instance, ingress: this.createIngress(instance) });
        return { ...base, status: 'applied' };
      }
      if (managed.inFlightInbound > 0 || managed.inFlightOutbound > 0) {
        return { ...base, status: 'failed', code: 'channel-activity-in-flight' };
      }
      await this.manager.replaceInstance(
        { instance, ingress: this.createIngress(instance) },
        this.deadline(),
      );
      this.consumedAuth.delete(keyOf(instance));
      return { ...base, status: 'applied' };
    } catch (error) {
      return { ...base, status: 'failed', code: errorCode(error) };
    }
  }

  /**
   * Reconnect preserves the live runtime when desired state is unchanged and
   * fails before any disconnect when the desired record drifted.
   */
  async reconnectInstance(instance: ResolvedChannelInstance): Promise<ChannelReconcileOutcome> {
    const base = { operation: 'reconnect' as const, instanceId: instance.instanceId, pluginId: instance.pluginId };
    const current = this.manager.instanceFor(instance);
    if (!current) return { ...base, status: 'failed', code: 'channel-instance-not-running' };
    if (!sameInstance(current, instance)) {
      return { ...base, status: 'failed', code: 'channel-desired-drift' };
    }
    return { ...base, status: 'applied' };
  }

  /**
   * Consume a stored auth intent once per intent value. Plugins that do not
   * implement provider auth report a stable unsupported code; the caller may
   * retry by issuing a new intent through the desired-state commands.
   */
  async reconcileAuth(instance: ResolvedChannelInstance): Promise<ChannelReconcileOutcome | undefined> {
    const auth = instance.auth;
    if (!auth) return undefined;
    const base = {
      operation: auth.intent === 'login' ? ('login' as const) : ('logout' as const),
      instanceId: instance.instanceId,
      pluginId: instance.pluginId,
    };
    const key = keyOf(instance);
    const marker = stableJson(auth);
    if (this.consumedAuth.get(key) === marker) return { ...base, status: 'skipped' };
    const runtime = this.manager.runtimeFor(instance);
    if (!runtime) return { ...base, status: 'failed', code: 'channel-instance-not-running' };
    const handler = auth.intent === 'login' ? runtime.login : runtime.logout;
    if (!handler) {
      this.consumedAuth.set(key, marker);
      return { ...base, status: 'failed', code: 'channel-auth-unsupported' };
    }
    try {
      const receipt = await handler.call(runtime, auth);
      this.consumedAuth.set(key, marker);
      return { ...base, status: 'applied', ...(receipt.code ? { code: receipt.code } : {}) };
    } catch (error) {
      return { ...base, status: 'failed', code: errorCode(error) };
    }
  }

  /**
   * Converge the runtime toward committed desired state. One failing instance
   * does not abort the others; the report status degrades to 'partial'.
   */
  async reconcile(input: ChannelReconcileInput): Promise<ChannelReconcileReport> {
    const outcomes: ChannelReconcileOutcome[] = [];
    const enabledInstances = input.instances.filter((instance) => instance.enabled);
    const neededPluginIds = new Set(enabledInstances.map((instance) => instance.pluginId));
    const blockedPluginIds = new Set<string>();
    const pendingLoads: ExternalChannelPluginRequest[] = [];

    for (const pluginId of neededPluginIds) {
      const trust = this.loader.trustFor(pluginId);
      if (!trust) {
        blockedPluginIds.add(pluginId);
        outcomes.push({ operation: 'load-package', pluginId, status: 'failed', code: 'channel-plugin-untrusted' });
        continue;
      }
      if (this.loader.isLoaded(trust.package)) continue;
      const pin = input.requests.find((request) => request.package === trust.package);
      if (!pin) {
        blockedPluginIds.add(pluginId);
        outcomes.push({ operation: 'load-package', pluginId, status: 'failed', code: 'channel-package-not-declared' });
        continue;
      }
      if (pin.version !== trust.version) {
        blockedPluginIds.add(pluginId);
        outcomes.push({ operation: 'load-package', pluginId, status: 'failed', code: 'channel-package-pin-mismatch' });
        continue;
      }
      pendingLoads.push(pin);
    }

    if (pendingLoads.length > 0) {
      try {
        await this.loader.load(pendingLoads, input.instances);
        for (const request of pendingLoads) {
          outcomes.push({ operation: 'load-package', pluginId: this.trustByPackageName(request.package)?.pluginId, status: 'applied' });
        }
      } catch (error) {
        const code = errorCode(error);
        for (const request of pendingLoads) {
          const trust = this.trustByPackageName(request.package);
          if (trust) blockedPluginIds.add(trust.pluginId);
          outcomes.push({ operation: 'load-package', pluginId: trust?.pluginId, status: 'failed', code });
        }
      }
    }

    const desiredByKey = new Map(input.instances.map((instance) => [keyOf(instance), instance]));
    for (const managed of this.manager.snapshot().instances) {
      const desired = desiredByKey.get(keyOf(managed));
      if (desired?.enabled) continue;
      outcomes.push(await this.stopInstance(managed));
    }

    for (const instance of input.instances) {
      if (!instance.enabled || blockedPluginIds.has(instance.pluginId)) continue;
      const current = this.manager.instanceFor(instance);
      if (!current) {
        outcomes.push(await this.startInstance(instance));
      } else if (!sameInstance(current, instance)) {
        outcomes.push(await this.restartInstance(instance));
      }
      const authOutcome = await this.reconcileAuth(instance);
      if (authOutcome) outcomes.push(authOutcome);
    }

    const loadedPluginIds = new Set(this.loader.list().map((entry) => entry.pluginId));
    for (const pluginId of loadedPluginIds) {
      if (neededPluginIds.has(pluginId)) continue;
      const trust = this.loader.trustFor(pluginId);
      if (!trust) continue;
      try {
        this.loader.unload(trust.package);
        outcomes.push({ operation: 'unload-package', pluginId, status: 'applied' });
      } catch (error) {
        outcomes.push({ operation: 'unload-package', pluginId, status: 'failed', code: errorCode(error) });
      }
    }

    return {
      profile: this.options.profileId,
      status: outcomes.some((outcome) => outcome.status === 'failed')
        ? outcomes.some((outcome) => outcome.status === 'applied')
          ? 'partial'
          : 'failed'
        : 'applied',
      outcomes,
    };
  }

  async close(): Promise<void> {
    this.closePromise ??= (async () => {
      const failures: unknown[] = [];
      await this.manager.close().catch((error) => failures.push(error));
      try {
        this.loader.unloadAll();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'external channel runtime admin failed to close');
      }
    })();
    return this.closePromise;
  }

  private managedEntry(ref: ChannelInstanceRef) {
    return this.manager
      .snapshot()
      .instances.find((entry) => keyOf(entry) === keyOf(ref));
  }

  private deadline(): ChannelDrainOptions {
    const base = this.options.now?.() ?? Date.now();
    return { deadlineAt: base + (this.options.deadlineMs ?? DEFAULT_OPERATION_DEADLINE_MS) };
  }

  private createIngress(instance: ResolvedChannelInstance): ChannelIngressPort {
    if (this.options.spaces) {
      const ingress = this.options.composition.createSpaceIngress?.({
        profileId: this.options.profileId,
        spaces: this.options.spaces,
        instance,
      });
      if (!ingress || ingress.spaceAuthority !== this.options.spaces.services) {
        throw new ChannelPluginError(
          'external channel requires its prepared space ingress authority',
          { kind: 'configuration', code: 'channel-space-ingress-unavailable' },
        );
      }
      return ingress;
    }
    return this.options.composition.createIngress({ profileId: this.options.profileId });
  }

  private trustByPackageName(packageName: string) {
    return this.options.composition.trustedPackages.find((entry) => entry.package === packageName);
  }
}
