import type { AgentAdapter } from '../types';
import type { ModelOption } from '../models';

export interface EngineUsageWindow {
  label: string;
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

/** Optional live metadata exposed by a long-lived engine runtime. */
export interface EngineStatusSnapshot {
  model?: string;
  account?: string;
  plan?: string;
  contextWindow?: {
    usedTokens: number;
    totalTokens?: number;
  };
  rateLimits?: EngineUsageWindow[];
  updatedAt: number;
}

/**
 * One live engine instance owned by a profile runtime.
 *
 * `execution` preserves the existing AgentAdapter contract. Engines that later
 * own long-lived processes, sockets, or subscriptions can release them from
 * `dispose` without leaking engine-specific lifecycle details into Supervisor.
 */
export interface EngineRuntime {
  readonly engineId: string;
  readonly execution: AgentAdapter;
  statusSnapshot?(): Promise<EngineStatusSnapshot>;
  /** Models exposed by the live engine connection, when supported. */
  listModels?(signal: AbortSignal): Promise<ModelOption[]>;
  dispose(): Promise<void>;
}
