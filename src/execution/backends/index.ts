import type { ExecutionBackendAdapter } from './types';
import { podmanBackendAdapter } from './podman';

/**
 * Persisted `backend` ids dispatch here. Supporting a new container or
 * isolation runtime means adding an adapter file and one row in this table;
 * the definition schema, Space deployment, and launch layers stay unchanged.
 */
export const EXECUTION_BACKENDS: Readonly<Record<string, ExecutionBackendAdapter>> = {
  [podmanBackendAdapter.id]: podmanBackendAdapter,
};

export function executionBackendAdapter(id: string): ExecutionBackendAdapter | undefined {
  return EXECUTION_BACKENDS[id];
}
