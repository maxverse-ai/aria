import type { ExecutionBackend } from '../types';

/** One adapter owns the persisted `configuration` block for a `backend` id. */
export interface ExecutionBackendAdapter<C = unknown> {
  readonly id: string;
  /** Validate and freeze the persisted configuration block for this backend. */
  normalizeConfiguration(value: unknown): C;
  /** Construct the runtime backend from validated config and resolved env. */
  create(configuration: C, managerEnv: Readonly<Record<string, string>>): ExecutionBackend;
}
