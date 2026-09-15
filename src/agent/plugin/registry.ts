import { registerRuntimeQueries, runtimeQueries } from '../runtime/queries';
import type { AppPaths } from '../../config/app-paths';
import type { EngineProfileConfig } from '../../config/profile-schema';
import type { AgentCapability } from '../capability';
import { BUILTIN_ENGINE_PLUGINS, getBuiltinEngineRuntimeFactory } from '../engines';
import {
  copyLegacyEnginePluginContext,
  resolveEngineRuntimeConstructionContext,
  type PreparedEngineRuntime,
} from '../runtime/construction';
import {
  assertEngineRuntimeDescriptor,
  defineEngineRuntimeDescriptor,
  type EngineRuntime,
} from '../runtime/types';
import type {
  EngineAutomationCapability,
  EnginePlugin,
  EnginePluginContext,
  EnginePluginPackage,
  EngineProbe,
} from './types';

const plugins = new Map<string, EnginePlugin>();
const externalIds = new Set<string>();
const activeRuntimeCounts = new Map<string, number>();
const listeners = new Set<(event: { type: 'loaded' | 'unloaded'; id: string }) => void>();
let builtinsRegistered = false;

function ensureBuiltins(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  for (const plugin of BUILTIN_ENGINE_PLUGINS) {
    if (!plugins.has(plugin.id)) registerEnginePlugin(plugin);
  }
}

export function registerEnginePlugin(plugin: EnginePlugin): void {
  if (!plugin?.id || !plugin.createRuntime || !plugin.capability) {
    throw new Error(`invalid engine plugin: ${plugin?.id ?? '<missing id>'}`);
  }
  if (plugin.automationCapabilities?.some((capability) => capability !== 'scheduled-triggers')) {
    throw new Error(`invalid engine plugin automation capability: ${plugin.id}`);
  }
  const existing = plugins.get(plugin.id);
  if (existing === plugin) return;
  if (existing) {
    throw new Error(`engine plugin already registered: ${plugin.id}`);
  }
  plugins.set(plugin.id, plugin);
}

export function onEnginePluginEvent(
  listener: (event: { type: 'loaded' | 'unloaded'; id: string }) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitEnginePluginEvent(type: 'loaded' | 'unloaded', id: string): void {
  for (const listener of listeners) listener({ type, id });
}

/** Remove a dynamically loaded engine plugin. Built-ins cannot be unloaded. */
export function unloadEnginePlugin(id: string): boolean {
  if ((activeRuntimeCounts.get(id) ?? 0) > 0) {
    throw new Error(`cannot unload active engine plugin: ${id}`);
  }
  if (!externalIds.delete(id)) return false;
  plugins.delete(id);
  emitEnginePluginEvent('unloaded', id);
  return true;
}

export function getEnginePlugin(id: string): EnginePlugin | undefined {
  ensureBuiltins();
  return plugins.get(id);
}

export function requireEnginePlugin(id: string): EnginePlugin {
  const plugin = getEnginePlugin(id);
  if (!plugin) {
    throw new Error(`unsupported agent engine: ${id}`);
  }
  return plugin;
}

export function listEnginePlugins(): EnginePlugin[] {
  ensureBuiltins();
  return [...plugins.values()];
}

export function capabilityFor(id: string, profile: EngineProfileConfig): AgentCapability {
  return requireEnginePlugin(id).capability(profile);
}

export function engineSupportsAutomation(id: string, capability: EngineAutomationCapability): boolean {
  return requireEnginePlugin(id).automationCapabilities?.includes(capability) === true;
}

export function createEngineRuntime(id: string, ctx: EnginePluginContext): EngineRuntime {
  return prepareEngineRuntime(id, ctx).create();
}

/** Internal two-stage construction; the public plugin and runtime v1 stay intact. */
export function prepareEngineRuntime(id: string, ctx: EnginePluginContext): PreparedEngineRuntime {
  const plugin = requireEnginePlugin(id);
  const factory = getBuiltinEngineRuntimeFactory(plugin);
  let prepared: PreparedEngineRuntime;
  if (factory) {
    prepared = factory.prepare(ctx);
  } else {
    // Preserve the v1 shape, including extra profile/path fields. Give each
    // external instance its own mutable projection of the prepared snapshot.
    const snapshot = copyLegacyEnginePluginContext(ctx);
    prepared = {
      context: resolveEngineRuntimeConstructionContext(id, snapshot),
      create: () => plugin.createRuntime(copyLegacyEnginePluginContext(snapshot)),
    };
  }
  return Object.freeze({
    context: prepared.context,
    create(): EngineRuntime {
      if (requireEnginePlugin(id) !== plugin) {
        throw new Error(`engine plugin changed after runtime preparation: ${id}`);
      }
      return manageEngineRuntime(id, prepared.create());
    },
  });
}

function manageEngineRuntime(id: string, runtime: EngineRuntime): EngineRuntime {
  // Keep already-compiled pre-v1 external plugins loadable. Missing metadata
  // is normalized conservatively and never inferred from the engine id.
  const descriptor = runtime?.descriptor ?? defineEngineRuntimeDescriptor({
    engineId: id,
    topology: 'one-shot',
  });
  try {
    assertEngineRuntimeDescriptor(descriptor, id);
  } catch (err) {
    throw new Error(
      `engine plugin ${id} returned an invalid runtime: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !runtime ||
    runtime.engineId !== id ||
    runtime.execution?.id !== id ||
    typeof runtime.dispose !== 'function'
  ) {
    throw new Error(`engine plugin ${id} returned an invalid runtime`);
  }

  activeRuntimeCounts.set(id, (activeRuntimeCounts.get(id) ?? 0) + 1);
  let disposed = false;
  const tracked: EngineRuntime = {
    engineId: runtime.engineId,
    descriptor,
    execution: runtime.execution,
    ...(runtime.statusSnapshot
      ? { statusSnapshot: () => runtime.statusSnapshot!() }
      : {}),
    ...(runtime.listModels
      ? { listModels: (signal: AbortSignal) => runtime.listModels!(signal) }
      : {}),
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        await runtime.dispose();
      } finally {
        const remaining = (activeRuntimeCounts.get(id) ?? 1) - 1;
        if (remaining > 0) activeRuntimeCounts.set(id, remaining);
        else activeRuntimeCounts.delete(id);
      }
    },
  };
  registerRuntimeQueries(tracked, runtimeQueries(runtime));
  return tracked;
}

export function modelOptionsFor(id: string) {
  return requireEnginePlugin(id).modelOptions?.();
}

/** Flatten every plugin probe for first-run agent detection. */
export function engineProbes(): Array<{ id: string; probe: EngineProbe }> {
  return listEnginePlugins().flatMap((plugin) =>
    plugin.probes.map((probe) => ({ id: plugin.id, probe })),
  );
}

/**
 * Load external engine plugins by package name. Each package must export an
 * `enginePlugin` member (or default-export one) that satisfies the contract.
 */
export async function loadExternalEnginePlugins(
  packageNames: readonly string[],
  appPaths?: Pick<AppPaths, 'profileDir'>,
): Promise<string[]> {
  const loaded: string[] = [];
  for (const name of packageNames) {
    const mod = (await import(name)) as EnginePluginPackage | { default?: EnginePluginPackage } | undefined;
    const plugin =
      (mod as EnginePluginPackage | undefined)?.enginePlugin ??
      (mod as { default?: EnginePluginPackage } | undefined)?.default?.enginePlugin;
    if (!plugin?.id) {
      throw new Error(`engine plugin package ${name} does not export a valid enginePlugin`);
    }
    registerEnginePlugin(plugin);
    externalIds.add(plugin.id);
    emitEnginePluginEvent('loaded', plugin.id);
    loaded.push(plugin.id);
  }
  return loaded;
}

ensureBuiltins();
