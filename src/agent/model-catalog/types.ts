import type { ProfileConfig } from '../../config/profile-schema';
import type { ModelOption } from '../models';

export type ModelCatalogSource = 'runtime' | 'plugin' | 'cache' | 'static';

export interface ModelCatalogSnapshot {
  profileId: string;
  engineId: string;
  models: ModelOption[];
  source: ModelCatalogSource;
  fetchedAt?: number;
  stale: boolean;
  refreshing: boolean;
  revision: number;
  error?: string;
}

export interface ModelCatalogQuery {
  profileId: string;
  engineId: string;
  profileConfig: ProfileConfig;
  runtimeGeneration?: number;
  runtimeOnly?: boolean;
  cacheScope?: string;
  runtimeModels?: (signal: AbortSignal) => Promise<ModelOption[] | undefined>;
}
