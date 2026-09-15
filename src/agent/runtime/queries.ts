import type { EngineHistoryEntry } from '../plugin/types';
import type { EngineRuntime } from './types';

export interface RuntimeQueries {
  listHistory?(input: { cwd: string; limit: number; signal?: AbortSignal }): Promise<EngineHistoryEntry[]>;
}
const queries = new WeakMap<EngineRuntime, RuntimeQueries>();
/** Internal extension: external Engine Runtime v1 objects keep their original ABI. */
export function registerRuntimeQueries<T extends EngineRuntime>(runtime: T, value: RuntimeQueries): T {
  queries.set(runtime, Object.freeze(value)); return runtime;
}
export function runtimeQueries(runtime: EngineRuntime): Readonly<RuntimeQueries> {
  return queries.get(runtime) ?? {};
}
