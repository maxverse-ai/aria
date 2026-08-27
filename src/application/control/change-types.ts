import type { RootConfig } from '../../config/profile-schema';

export const CONTROL_CHANGE_API_VERSION = 1 as const;

export type ControlChangeRisk = 'low' | 'sensitive' | 'destructive';
export type ControlChangeSource = 'local-cli' | 'agent' | 'card' | 'web';
export type ControlChangePlanStatus = 'planned' | 'confirmed' | 'applied';
export type ControlPlanScalar = string | number | boolean | null;
export type ControlPlanParameters = Record<string, ControlPlanScalar>;

export interface ControlActorContext {
  source: ControlChangeSource;
  /** Stable principal supplied by a trusted adapter. Never returned or persisted verbatim. */
  principal: string;
}

export interface ControlActorReference {
  source: ControlChangeSource;
  fingerprint: string;
}

export interface ControlChangeSummary {
  field: string;
  before: ControlPlanScalar;
  after: ControlPlanScalar;
}

export interface ConfigChangeOperation {
  id: string;
  version: 1;
  risk: ControlChangeRisk;
  /** Persisted changes require a bridge restart when no live-state adapter exists. */
  restartRequired: boolean;
  /** Pure deterministic transformation. Parameters must be non-secret. */
  prepare(input: {
    root: RootConfig;
    profile: string;
    parameters: ControlPlanParameters;
  }): ConfigChangeCandidate;
}

export interface ConfigChangeCandidate {
  root: RootConfig;
  changes: ControlChangeSummary[];
}

export interface ControlChangePlanSnapshot {
  schema: 'aria.control.change-plan.v1';
  apiVersion: typeof CONTROL_CHANGE_API_VERSION;
  id: string;
  profile: string;
  operation: {
    id: string;
    version: 1;
    risk: ControlChangeRisk;
    restartRequired: boolean;
  };
  status: ControlChangePlanStatus;
  actor: ControlActorReference;
  baseRevision: string;
  targetRevision: string;
  changes: ControlChangeSummary[];
  createdAt: string;
  expiresAt: string;
  confirmedAt?: string;
  appliedAt?: string;
}

export interface ControlChangeApplyResult {
  schema: 'aria.control.change-apply.v1';
  apiVersion: typeof CONTROL_CHANGE_API_VERSION;
  planId: string;
  profile: string;
  baseRevision: string;
  resultRevision: string;
  appliedAt: string;
  recovered: boolean;
  restartRequired: boolean;
}

export type ControlChangeErrorCode =
  | 'actor-mismatch'
  | 'expired'
  | 'invalid-plan'
  | 'not-confirmed'
  | 'operation-unavailable'
  | 'plan-not-found'
  | 'profile-not-found'
  | 'revision-conflict'
  | 'transformation-drift';

export class ControlChangeError extends Error {
  constructor(
    public readonly code: ControlChangeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ControlChangeError';
  }
}

export interface StoredControlChangePlan extends ControlChangePlanSnapshot {
  /** Non-secret operation input. Deliberately omitted from public snapshots. */
  parameters: ControlPlanParameters;
}
