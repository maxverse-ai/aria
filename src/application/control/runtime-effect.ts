export const MANAGEMENT_RUNTIME_EFFECTS = [
  'none',
  'live',
  'reconnect',
  'engine-switch',
  'restart',
] as const;

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

/**
 * Safe default for adapters that can commit desired state but do not own a
 * running profile. The caller can retry the same committed plan later with a
 * runtime-aware reconciler without repeating the configuration write.
 */
export class DeferredRuntimeReconciler implements RuntimeReconciler {
  constructor(private readonly reason = 'runtime-reconciler-unavailable') {}

  async reconcile(request: RuntimeReconcileRequest): Promise<RuntimeReconcileOutcome> {
    if (request.effect === 'none') return { status: 'not-required', effect: 'none' };
    return { status: 'deferred', effect: request.effect, reason: this.reason };
  }
}
