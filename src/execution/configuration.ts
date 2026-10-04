import { executionBackendAdapter } from './backends';
import type { ExecutionBackend } from './types';

/**
 * Persistable intent only. Credential values are resolved by the composition
 * root. `backend` names a registered adapter (see `backends/`), and
 * `configuration` is that adapter's own persisted block.
 */
export interface ExecutionDefinition {
  schema: 'aria.execution.v1';
  backend: string;
  /** Adapter-owned block; the selected adapter validates its exact shape. */
  configuration: Record<string, unknown>;
  managerEnvironmentKeys: readonly string[];
}

export function normalizeExecutionDefinition(value: unknown): ExecutionDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid execution definition');
  const v = value as ExecutionDefinition;
  const adapter = typeof v.backend === 'string' ? executionBackendAdapter(v.backend) : undefined;
  if (v.schema !== 'aria.execution.v1' || !adapter
    || Object.keys(v).some(k => !['schema', 'backend', 'configuration', 'managerEnvironmentKeys'].includes(k))
    || !Array.isArray(v.managerEnvironmentKeys) || !v.managerEnvironmentKeys.includes('HOME')
    || new Set(v.managerEnvironmentKeys).size !== v.managerEnvironmentKeys.length
    || v.managerEnvironmentKeys.some(k => typeof k !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(k)
      || /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$)/.test(k))) {
    throw new Error('invalid execution definition');
  }
  adapter.normalizeConfiguration(v.configuration);
  return structuredClone(v);
}

/** Runtime selection is confined to this adapter boundary, not Space business code. */
export function createExecutionBackend(value: ExecutionDefinition, env: NodeJS.ProcessEnv = process.env): ExecutionBackend {
  const definition = normalizeExecutionDefinition(value);
  const adapter = executionBackendAdapter(definition.backend)!;
  const managerEnv: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  for (const key of definition.managerEnvironmentKeys) {
    if (!env[key]) throw new Error('required execution manager environment is unavailable: ' + key);
    managerEnv[key] = env[key]!;
  }
  return adapter.create(adapter.normalizeConfiguration(definition.configuration), managerEnv);
}
