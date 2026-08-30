import type { AgentAdapter } from '../types';
import {
  defineEngineRuntimeDescriptor,
  type EngineRuntime,
  type EngineRuntimeDescriptor,
} from './types';

/** Wrap a stateless/one-shot adapter in the managed runtime contract. */
export function createAdapterRuntime(
  execution: AgentAdapter,
  descriptor: EngineRuntimeDescriptor = defineEngineRuntimeDescriptor({
    engineId: execution.id,
    topology: 'one-shot',
  }),
): EngineRuntime {
  if (descriptor.engineId !== execution.id) {
    throw new Error(
      `runtime descriptor engine id ${descriptor.engineId} does not match adapter ${execution.id}`,
    );
  }
  return {
    engineId: execution.id,
    descriptor,
    execution,
    async dispose(): Promise<void> {
      // One-shot CLI adapters do not currently retain resources between runs.
    },
  };
}
