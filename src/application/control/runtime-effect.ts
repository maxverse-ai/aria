export const MANAGEMENT_RUNTIME_EFFECTS = ['none', 'live', 'reconnect', 'restart'] as const;

export type ManagementRuntimeEffect = (typeof MANAGEMENT_RUNTIME_EFFECTS)[number];

export function runtimeEffectRequiresRestart(effect: ManagementRuntimeEffect): boolean {
  return effect === 'restart';
}

export interface RuntimeReconcileRequest {
  profile: string;
  effect: ManagementRuntimeEffect;
  revision: string;
}

export type RuntimeReconcileOutcome =
  | { status: 'not-required'; effect: 'none' }
  | { status: 'applied'; effect: Exclude<ManagementRuntimeEffect, 'none'> }
  | { status: 'deferred'; effect: Exclude<ManagementRuntimeEffect, 'none'>; reason: string }
  | { status: 'failed'; effect: Exclude<ManagementRuntimeEffect, 'none'>; code: string };

/** Runtime effects consume an already-committed desired-state revision. */
export interface RuntimeReconciler {
  reconcile(request: RuntimeReconcileRequest): Promise<RuntimeReconcileOutcome>;
}
