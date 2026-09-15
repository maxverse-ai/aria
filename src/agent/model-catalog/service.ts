import { createHash } from 'node:crypto';
import { log } from '../../core/logger';
import type { ModelOption } from '../models';
import {
  discoverModelOptions,
  mergeModelOptions,
  modelProviderConfig,
  staticModelOptions,
} from './providers';
import type { ModelCatalogQuery, ModelCatalogSnapshot, ModelCatalogSource } from './types';

const FRESH_TTL_MS = 5 * 60_000;
const STALE_TTL_MS = 24 * 60 * 60_000;
const SOFT_TIMEOUT_MS = 3_000;
const HARD_TIMEOUT_MS = 8_000;
const FAILURE_COOLDOWN_MS = 30_000;

interface CacheEntry {
  models: ModelOption[];
  source: Exclude<ModelCatalogSource, 'cache'>;
  fetchedAt: number;
  revision: number;
  error?: string;
  retryAfter?: number;
}

interface InFlight {
  promise: Promise<ModelCatalogSnapshot>;
  generation: number;
}

/** Profile-scoped, cache-first model discovery with bounded provider I/O. */
export class ModelCatalogService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlight>();
  private revision = 0;

  getSnapshot(query: ModelCatalogQuery): ModelCatalogSnapshot {
    const key = catalogKey(query);
    const cached = this.cache.get(key);
    const now = Date.now();
    const fallback = staticModelOptions(query.engineId);
    if (!cached || now - cached.fetchedAt > STALE_TTL_MS) {
      return {
        profileId: query.profileId,
        engineId: query.engineId,
        models: fallback,
        source: 'static',
        stale: true,
        refreshing: this.inFlight.has(key),
        revision: cached?.revision ?? this.revision,
        ...(cached?.error ? { error: cached.error } : {}),
      };
    }
    return {
      profileId: query.profileId,
      engineId: query.engineId,
      models: cached.models,
      source: now - cached.fetchedAt <= FRESH_TTL_MS ? cached.source : 'cache',
      fetchedAt: cached.fetchedAt,
      stale: now - cached.fetchedAt > FRESH_TTL_MS,
      refreshing: this.inFlight.has(key),
      revision: cached.revision,
      ...(cached.error ? { error: cached.error } : {}),
    };
  }

  async list(query: ModelCatalogQuery, force = false): Promise<ModelCatalogSnapshot> {
    const snapshot = this.getSnapshot(query);
    const key = catalogKey(query);
    const cached = this.cache.get(key);
    if (!force && !snapshot.stale) return snapshot;
    if (!force && cached) {
      void this.refresh(query).catch(() => undefined);
      return snapshot;
    }
    const refresh = this.refresh(query);
    return new Promise<ModelCatalogSnapshot>((resolve) => {
      const timer = setTimeout(() => {
        log.warn('model-catalog', 'soft-timeout', {
          profile: query.profileId,
          engine: query.engineId,
          timeoutMs: SOFT_TIMEOUT_MS,
        });
        resolve(this.getSnapshot(query));
      }, SOFT_TIMEOUT_MS);
      void refresh.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  refresh(query: ModelCatalogQuery): Promise<ModelCatalogSnapshot> {
    const key = catalogKey(query);
    const active = this.inFlight.get(key);
    const generation = query.runtimeGeneration ?? 0;
    if (active?.generation === generation) return active.promise;
    const cached = this.cache.get(key);
    if (cached?.retryAfter && cached.retryAfter > Date.now()) {
      return Promise.resolve(this.getSnapshot(query));
    }

    const startedAt = Date.now();
    log.info('model-catalog', 'refresh-start', { profile: query.profileId, engine: query.engineId });
    const promise = this.discover(query).then(({ models, source }) => {
      const current = this.inFlight.get(key);
      if (!current || current.promise !== promise || current.generation !== generation) {
        log.warn('model-catalog', 'stale-result-dropped', {
          profile: query.profileId,
          engine: query.engineId,
          generation,
        });
        return this.getSnapshot(query);
      }
      const merged = mergeModelOptions(models, staticModelOptions(query.engineId));
      this.cache.set(key, {
        models: merged,
        source,
        fetchedAt: Date.now(),
        revision: ++this.revision,
      });
      log.info('model-catalog', 'refresh-success', {
        profile: query.profileId,
        engine: query.engineId,
        source,
        durationMs: Date.now() - startedAt,
        modelCount: merged.length,
      });
      return this.getSnapshot(query);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const previous = this.cache.get(key);
      if (previous) {
        this.cache.set(key, { ...previous, error: message, retryAfter: Date.now() + FAILURE_COOLDOWN_MS });
      } else {
        this.cache.set(key, {
          models: staticModelOptions(query.engineId),
          source: 'static',
          fetchedAt: 0,
          revision: ++this.revision,
          error: message,
          retryAfter: Date.now() + FAILURE_COOLDOWN_MS,
        });
      }
      log.warn('model-catalog', 'fallback-static', {
        profile: query.profileId,
        engine: query.engineId,
        durationMs: Date.now() - startedAt,
        err: message,
      });
      return this.getSnapshot(query);
    }).finally(() => {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, { promise, generation });
    return promise;
  }

  invalidate(query: Pick<ModelCatalogQuery, 'profileId' | 'engineId'>): void {
    const prefix = `${query.profileId}\u0000${query.engineId}\u0000`;
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
    for (const key of this.inFlight.keys()) if (key.startsWith(prefix)) this.inFlight.delete(key);
  }

  private async discover(query: ModelCatalogQuery): Promise<{
    models: ModelOption[];
    source: Exclude<ModelCatalogSource, 'cache'>;
  }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const hardTimeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('model discovery hard timeout');
        controller.abort(error);
        log.warn('model-catalog', 'hard-timeout', {
          profile: query.profileId,
          engine: query.engineId,
          timeoutMs: HARD_TIMEOUT_MS,
        });
        reject(error);
      }, HARD_TIMEOUT_MS);
    });
    try {
      return await Promise.race([discoverProviders(), hardTimeout]);
    } finally {
      clearTimeout(timer!);
    }

    function discoverProviders() {
      return discoverModelOptions(query, controller.signal);
    }
  }
}

function catalogKey(query: ModelCatalogQuery): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(modelProviderConfig(query)))
    .digest('hex')
    .slice(0, 16);
  return [query.profileId, query.engineId, query.runtimeGeneration ?? 0, fingerprint, query.runtimeOnly ? 'owned' : 'legacy', query.cacheScope ?? ''].join('\u0000');
}

export const modelCatalog = new ModelCatalogService();
