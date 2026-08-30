import type { AppPaths } from '../../config/app-paths';
import type { ProfileConfig } from '../../config/profile-schema';
import type { AgentCapability } from '../capability';
import { BUILTIN_ENGINE_PLUGINS } from '../engines';
import {
  assertEngineRuntimeDescriptor,
  defineEngineRuntimeDescriptor,
  type EngineRuntime,
} from '../runtime/types';
import type { EnginePlugin, EnginePluginContext, EnginePluginPackage, EngineProbe } from './types';

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

export function capabilityFor(id: string, profile: ProfileConfig): AgentCapability {
  return requireEnginePlugin(id).capability(profile);
}

export function createEngineRuntime(id: string, ctx: EnginePluginContext): EngineRuntime {
  const runtime = requireEnginePlugin(id).createRuntime(ctx);
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
  return {
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
