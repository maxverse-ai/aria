import type { AgentAdapter } from '../types';
import type { EngineRuntime } from './types';

/** Wrap a stateless/one-shot adapter in the managed runtime contract. */
export function createAdapterRuntime(execution: AgentAdapter): EngineRuntime {
  return {
    engineId: execution.id,
    execution,
    async dispose(): Promise<void> {
      // One-shot CLI adapters do not currently retain resources between runs.
    },
  };
}
