import { PodmanExecutionBackend, validatePodmanConfiguration, type PodmanConfiguration } from './podman';
import type { ExecutionBackend } from './types';

/** Persistable intent only. Credential values are resolved by the composition root. */
export interface ExecutionDefinition {
  schema: 'aria.execution.v1';
  backend: 'podman';
  configuration: Omit<PodmanConfiguration, 'managerEnv'>;
  managerEnvironmentKeys: readonly string[];
}

export function normalizeExecutionDefinition(value: unknown): ExecutionDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid execution definition');
  const v = value as ExecutionDefinition;
  const keys = ['binary', 'image', 'user', 'network', 'memoryBytes', 'cpus', 'pids', 'tmpBytes', 'managerCwd'];
  if (v.schema !== 'aria.execution.v1' || v.backend !== 'podman' || !v.configuration
    || Object.keys(v).some(k => !['schema', 'backend', 'configuration', 'managerEnvironmentKeys'].includes(k))
    || Object.keys(v.configuration).some(k => !keys.includes(k))
    || !Array.isArray(v.managerEnvironmentKeys) || !v.managerEnvironmentKeys.includes('HOME')
    || new Set(v.managerEnvironmentKeys).size !== v.managerEnvironmentKeys.length
    || v.managerEnvironmentKeys.some(k => typeof k !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(k)
      || /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$)/.test(k))) {
    throw new Error('invalid execution definition');
  }
  validatePodmanConfiguration({ ...v.configuration, managerEnv: {} });
  return structuredClone(v);
}

/** Runtime selection is confined to this adapter boundary, not Space business code. */
export function createExecutionBackend(value: ExecutionDefinition, env: NodeJS.ProcessEnv = process.env): ExecutionBackend {
  const definition = normalizeExecutionDefinition(value);
  const managerEnv: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  for (const key of definition.managerEnvironmentKeys) {
    if (!env[key]) throw new Error('required execution manager environment is unavailable: ' + key);
    managerEnv[key] = env[key]!;
  }
  return new PodmanExecutionBackend({ ...definition.configuration, managerEnv });
}
