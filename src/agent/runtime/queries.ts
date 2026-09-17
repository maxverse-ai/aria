import type { EngineHistoryEntry } from '../plugin/types';
import type { EngineRuntime } from './types';

export interface RuntimeQueries {
  listHistory?(input: { cwd: string; limit: number; signal?: AbortSignal }): Promise<EngineHistoryEntry[]>;
  goal?: EngineGoalControl;
}

/**
 * Engine-independent view of one thread's long-running objective. Engines that
 * cannot carry a goal leave {@link RuntimeQueries.goal} unset, so callers must
 * never infer support from an engine id.
 */
export interface EngineGoalSnapshot {
  objective: string;
  status: EngineGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * `active` means the engine keeps starting turns toward the objective on its
 * own; every other state leaves the next turn to the caller.
 */
export type EngineGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete';

export interface EngineGoalSetInput {
  objective?: string;
  status?: EngineGoalStatus;
  tokenBudget?: number | null;
}

/** Reads and writes one thread's goal. Engine-initiated turns are not part of this contract. */
export interface EngineGoalControl {
  get(threadId: string): Promise<EngineGoalSnapshot | null>;
  set(threadId: string, input: EngineGoalSetInput): Promise<EngineGoalSnapshot>;
  clear(threadId: string): Promise<void>;
}
const queries = new WeakMap<EngineRuntime, RuntimeQueries>();
/** Internal extension: external Engine Runtime v1 objects keep their original ABI. */
export function registerRuntimeQueries<T extends EngineRuntime>(runtime: T, value: RuntimeQueries): T {
  queries.set(runtime, Object.freeze(value)); return runtime;
}
export function runtimeQueries(runtime: EngineRuntime): Readonly<RuntimeQueries> {
  return queries.get(runtime) ?? {};
}
