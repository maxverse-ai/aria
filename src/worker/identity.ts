export interface WorkerProductIdentity {
  /** Stable product identifier; never used as an authorization principal. */
  id: string;
  /** User-facing product name, independent from the Aria implementation name. */
  displayName: string;
}

export interface WorkerImplementationIdentity {
  id: 'aria';
  displayName: 'Aria';
  version: string;
}

export const DEFAULT_WORKER_PRODUCT_IDENTITY: WorkerProductIdentity = Object.freeze({
  id: 'aria',
  displayName: 'Aria',
});

export function resolveWorkerProductIdentity(
  input: WorkerProductIdentity | undefined,
): Readonly<WorkerProductIdentity> {
  const identity = input ?? DEFAULT_WORKER_PRODUCT_IDENTITY;
  const id = identity.id.trim();
  const displayName = identity.displayName.trim();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 80) {
    throw new Error('worker product identity id must be a lowercase kebab-case identifier');
  }
  if (!displayName || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(identity.displayName)) {
    throw new Error('worker product identity displayName must be 1-80 printable characters');
  }
  return Object.freeze({ id, displayName });
}
