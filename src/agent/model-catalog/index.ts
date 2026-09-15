import type { ProfileConfig } from '../../config/profile-schema';
import type { ModelOption } from '../models';
import { modelCatalog } from './service';
import type { ModelCatalogSnapshot } from './types';

export interface ListEngineModelsContext {
  profileId?: string;
  runtimeGeneration?: number;
  runtimeOnly?: boolean;
  cacheScope?: string;
  runtimeModels?: (signal: AbortSignal) => Promise<ModelOption[] | undefined>;
}

/** Compatibility-shaped model list backed by the unified catalog service. */
export async function listEngineModels(
  engineId: string,
  profileConfig: ProfileConfig,
  force = false,
  context: ListEngineModelsContext = {},
): Promise<ModelOption[]> {
  const snapshot = await modelCatalog.list({
    profileId: context.profileId ?? profileConfig.accounts.app.id,
    engineId,
    profileConfig,
    ...(context.runtimeGeneration !== undefined
      ? { runtimeGeneration: context.runtimeGeneration }
      : {}),
    ...(context.runtimeOnly ? { runtimeOnly: true } : {}),
    ...(context.cacheScope ? { cacheScope: context.cacheScope } : {}),
    ...(context.runtimeModels ? { runtimeModels: context.runtimeModels } : {}),
  }, force);
  return snapshot.models;
}

export function getEngineModelCatalog(
  engineId: string,
  profileConfig: ProfileConfig,
  context: ListEngineModelsContext = {},
): ModelCatalogSnapshot {
  return modelCatalog.getSnapshot({
    profileId: context.profileId ?? profileConfig.accounts.app.id,
    engineId,
    profileConfig,
    ...(context.runtimeGeneration !== undefined
      ? { runtimeGeneration: context.runtimeGeneration }
      : {}),
    ...(context.runtimeOnly ? { runtimeOnly: true } : {}),
    ...(context.cacheScope ? { cacheScope: context.cacheScope } : {}),
    ...(context.runtimeModels ? { runtimeModels: context.runtimeModels } : {}),
  });
}
