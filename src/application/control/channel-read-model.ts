import type { ChannelManagerSnapshot } from '../../channel/manager';
import { BUILT_IN_LARK_PLUGIN_ID } from '../../channel/instance-resolver';
import type {
  ChannelHealthSnapshot,
  ChannelInstanceRef,
  ChannelRuntimeState,
  ResolvedChannelInstance,
} from '../../channel/plugin/types';
import { channelRuntimeKey } from '../../channel/plugin/validation';
import { WECHAT_KF_PLUGIN_ID } from '../../channel/wechat-kf/reliable-message-sink';
import type { StoredChannelPluginPackage } from '../../config/profile-schema';
import type { ProfileExternalChannelRuntimeSnapshot } from '../../runtime/external-channel-runtime';

export const CHANNEL_READ_API_VERSION = 1 as const;

export const BUILT_IN_CHANNEL_PLUGIN_IDS: readonly string[] = Object.freeze([
  BUILT_IN_LARK_PLUGIN_ID,
  WECHAT_KF_PLUGIN_ID,
]);

/**
 * Bounded serializable projection states. `inactive` means the stored
 * instance is disabled; every other state mirrors the managed runtime
 * lifecycle (a `pending` manager entry is reported as `starting`).
 */
export const CHANNEL_INSTANCE_PROJECTION_STATES = [
  'inactive',
  'starting',
  'ready',
  'draining',
  'stopped',
  'failed',
  'reauth-required',
] as const;

export type ChannelInstanceProjectionState =
  (typeof CHANNEL_INSTANCE_PROJECTION_STATES)[number];

export type ChannelInstanceOrigin = 'built-in' | 'external';

/**
 * One instance row. Config payloads, secret refs, raw provider identities,
 * reply context, paths, and exception text are never projected — only stable
 * codes and counters survive the boundary.
 */
export interface ChannelInstanceProjection {
  pluginId: string;
  instanceId: string;
  origin: ChannelInstanceOrigin;
  desired: {
    enabled: boolean;
    configVersion: number;
    secretRefCount: number;
  };
  state: ChannelInstanceProjectionState;
  acceptingInbound: boolean;
  inFlightInbound: number;
  inFlightOutbound: number;
  updatedAt?: number;
  errorCode?: string;
  health?: Pick<ChannelHealthSnapshot, 'status' | 'code'>;
}

export interface ChannelPluginProjection {
  package: string;
  version: string;
  declared: boolean;
  loaded: boolean;
  pluginId?: string;
}

export interface ChannelStatusSnapshot {
  schema: 'aria.channel.status.v1';
  apiVersion: typeof CHANNEL_READ_API_VERSION;
  profileId: string;
  generatedAt: number;
  plugins: readonly ChannelPluginProjection[];
  instances: readonly ChannelInstanceProjection[];
}

export const CHANNEL_DIAGNOSTIC_SEVERITIES = ['info', 'warn', 'error'] as const;

export type ChannelDiagnosticSeverity =
  (typeof CHANNEL_DIAGNOSTIC_SEVERITIES)[number];

export interface ChannelDiagnostic {
  severity: ChannelDiagnosticSeverity;
  /** Stable machine code. Human/provider payloads do not belong here. */
  code: string;
  pluginId?: string;
  instanceId?: string;
}

/**
 * Runtime read sources are supplied by the caller. The read model never
 * loads packages, starts runtimes, or mutates desired/runtime state; health
 * snapshots are optional pre-fetched inputs, not triggered reads.
 */
export interface ChannelRuntimeReadSources {
  lark?: ChannelManagerSnapshot;
  external?: ProfileExternalChannelRuntimeSnapshot;
}

export interface ChannelHealthReport extends ChannelInstanceRef {
  health: ChannelHealthSnapshot;
}

export interface ChannelQueryInput {
  profileId: string;
  /** Resolved desired state; projection from stored config is a pure read. */
  instances: readonly ResolvedChannelInstance[];
  /** Stored package pins. Declared state alone never means loaded. */
  declaredPackages?: readonly StoredChannelPluginPackage[];
  runtime?: ChannelRuntimeReadSources;
  health?: readonly ChannelHealthReport[];
  now?: () => number;
}

interface RuntimeEntry {
  state: ChannelRuntimeState | 'pending';
  acceptingInbound: boolean;
  inFlightInbound: number;
  inFlightOutbound: number;
  updatedAt: number;
  errorCode?: string;
}

export function listChannelInstances(
  input: ChannelQueryInput,
): ChannelInstanceProjection[] {
  const runtimeEntries = collectRuntimeEntries(input.runtime);
  const healthByKey = collectHealth(input.health);
  return [...input.instances]
    .sort(compareInstances)
    .map((instance) =>
      projectInstance(
        instance,
        runtimeEntries.get(channelRuntimeKey(instance)),
        healthByKey.get(channelRuntimeKey(instance)),
      ),
    );
}

export function getChannelStatus(input: ChannelQueryInput): ChannelStatusSnapshot {
  return Object.freeze({
    schema: 'aria.channel.status.v1',
    apiVersion: CHANNEL_READ_API_VERSION,
    profileId: input.profileId,
    generatedAt: (input.now ?? Date.now)(),
    plugins: Object.freeze(listChannelPlugins(input)),
    instances: Object.freeze(listChannelInstances(input)),
  });
}

export function diagnoseChannels(input: ChannelQueryInput): ChannelDiagnostic[] {
  const status = getChannelStatus(input);
  const diagnostics: ChannelDiagnostic[] = [];
  const loadedPluginIds = new Set(
    status.plugins.filter((plugin) => plugin.loaded && plugin.pluginId).map(
      (plugin) => plugin.pluginId!,
    ),
  );
  for (const plugin of status.plugins) {
    if (plugin.declared && !plugin.loaded) {
      diagnostics.push({
        severity: 'warn',
        code: 'channel-package-declared-not-loaded',
      });
    }
    if (!plugin.declared && plugin.loaded) {
      diagnostics.push({ severity: 'info', code: 'channel-package-loaded-undeclared' });
    }
  }
  for (const instance of status.instances) {
    const ref = { pluginId: instance.pluginId, instanceId: instance.instanceId };
    if (instance.origin === 'external' && instance.desired.enabled && !loadedPluginIds.has(instance.pluginId)) {
      diagnostics.push({ severity: 'error', code: 'channel-plugin-not-loaded', ...ref });
    }
    if (instance.state === 'failed') {
      diagnostics.push({ severity: 'error', code: 'channel-instance-failed', ...ref });
    }
    if (instance.state === 'reauth-required') {
      diagnostics.push({ severity: 'warn', code: 'channel-reauth-required', ...ref });
    }
    if (instance.desired.enabled && instance.state === 'stopped') {
      diagnostics.push({ severity: 'info', code: 'channel-instance-not-running', ...ref });
    }
    if (instance.health && instance.health.status !== 'healthy') {
      diagnostics.push({ severity: 'warn', code: 'channel-health-degraded', ...ref });
    }
  }
  return diagnostics;
}

function listChannelPlugins(input: ChannelQueryInput): ChannelPluginProjection[] {
  const byPackage = new Map<string, ChannelPluginProjection>();
  for (const stored of input.declaredPackages ?? []) {
    byPackage.set(stored.package, {
      package: stored.package,
      version: stored.version,
      declared: true,
      loaded: false,
    });
  }
  for (const loaded of input.runtime?.external?.loadedPlugins ?? []) {
    const existing = byPackage.get(loaded.package);
    byPackage.set(loaded.package, {
      package: loaded.package,
      version: loaded.version,
      declared: existing?.declared ?? false,
      loaded: true,
      pluginId: loaded.pluginId,
    });
  }
  return [...byPackage.values()].sort((a, b) => a.package.localeCompare(b.package));
}

function collectRuntimeEntries(
  runtime: ChannelRuntimeReadSources | undefined,
): Map<string, RuntimeEntry> {
  const entries = new Map<string, RuntimeEntry>();
  for (const manager of [runtime?.lark, runtime?.external?.manager]) {
    for (const instance of manager?.instances ?? []) {
      entries.set(channelRuntimeKey(instance), instance);
    }
  }
  return entries;
}

function collectHealth(
  reports: readonly ChannelHealthReport[] | undefined,
): Map<string, ChannelHealthSnapshot> {
  const entries = new Map<string, ChannelHealthSnapshot>();
  for (const report of reports ?? []) {
    entries.set(channelRuntimeKey(report), report.health);
  }
  return entries;
}

function projectInstance(
  instance: ResolvedChannelInstance,
  runtime: RuntimeEntry | undefined,
  health: ChannelHealthSnapshot | undefined,
): ChannelInstanceProjection {
  const projection: ChannelInstanceProjection = {
    pluginId: instance.pluginId,
    instanceId: instance.instanceId,
    origin: BUILT_IN_CHANNEL_PLUGIN_IDS.includes(instance.pluginId)
      ? 'built-in'
      : 'external',
    desired: {
      enabled: instance.enabled,
      configVersion: instance.configVersion,
      secretRefCount: Object.keys(instance.secretRefs).length,
    },
    state: projectState(instance, runtime),
    acceptingInbound: runtime?.acceptingInbound ?? false,
    inFlightInbound: runtime?.inFlightInbound ?? 0,
    inFlightOutbound: runtime?.inFlightOutbound ?? 0,
    ...(runtime?.updatedAt !== undefined ? { updatedAt: runtime.updatedAt } : {}),
    ...(runtime?.errorCode ? { errorCode: runtime.errorCode } : {}),
    ...(health
      ? { health: { status: health.status, ...(health.code ? { code: health.code } : {}) } }
      : {}),
  };
  return Object.freeze(projection);
}

function projectState(
  instance: ResolvedChannelInstance,
  runtime: RuntimeEntry | undefined,
): ChannelInstanceProjectionState {
  if (!runtime) return instance.enabled ? 'stopped' : 'inactive';
  return runtime.state === 'pending' ? 'starting' : runtime.state;
}

function compareInstances(
  a: ResolvedChannelInstance,
  b: ResolvedChannelInstance,
): number {
  return a.pluginId.localeCompare(b.pluginId) || a.instanceId.localeCompare(b.instanceId);
}
