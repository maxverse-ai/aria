import type { ModelOption } from '../models';
import { getEnginePlugin } from '../plugin/registry';
import type { ModelCatalogQuery } from './types';

export interface DiscoveredModels {
  models: ModelOption[];
  source: 'runtime' | 'plugin' | 'static';
}

/** Resolve providers in lifecycle order without owning cache or UI policy. */
export async function discoverModelOptions(
  query: ModelCatalogQuery,
  signal: AbortSignal,
): Promise<DiscoveredModels> {
  let runtimeError: unknown;
  if (query.runtimeModels) {
    try {
      const runtime = await query.runtimeModels(signal);
      if (runtime?.length) {
        return { models: enrichReasoning(query.engineId, runtime), source: 'runtime' };
      }
    } catch (error) {
      if (signal.aborted) throw error;
      runtimeError = error;
    }
  }

  const plugin = getEnginePlugin(query.engineId);
  if (plugin?.modelLister) {
    const models = await plugin.modelLister({ profileConfig: query.profileConfig, signal });
    if (models.length) {
      return { models: enrichReasoning(query.engineId, models), source: 'plugin' };
    }
  }
  if (runtimeError) throw runtimeError;
  return { models: [], source: 'static' };
}

export function staticModelOptions(engineId: string): ModelOption[] {
  return enrichReasoning(engineId, getEnginePlugin(engineId)?.modelOptions?.() ?? []);
}

export function modelProviderConfig(query: ModelCatalogQuery): unknown {
  const field = getEnginePlugin(query.engineId)?.configField ?? query.engineId;
  return (query.profileConfig as unknown as Record<string, unknown>)[field] ?? {};
}

export function mergeModelOptions(dynamic: ModelOption[], fallback: ModelOption[]): ModelOption[] {
  const fallbackByValue = new Map(fallback.map((option) => [option.value, option]));
  const seen = new Set<string>();
  return [...dynamic, ...fallback]
    .filter((option) => {
      if (!option.value || seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    })
    .map((option) => {
      const staticOption = fallbackByValue.get(option.value);
      return option.reasoning || !staticOption?.reasoning
        ? option
        : { ...option, reasoning: staticOption.reasoning };
    });
}

function enrichReasoning(engineId: string, models: ModelOption[]): ModelOption[] {
  const provider = getEnginePlugin(engineId)?.reasoningOptions;
  if (!provider) return models;
  return models.map((model) =>
    model.reasoning
      ? model
      : { ...model, reasoning: provider(model.value) },
  );
}
