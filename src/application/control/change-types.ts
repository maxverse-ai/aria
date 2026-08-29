import type { RootConfig } from '../../config/profile-schema';
import type { ManagementRuntimeEffect } from './runtime-effect';

export const CONTROL_CHANGE_API_VERSION = 1 as const;

export type ControlChangeRisk = 'low' | 'sensitive' | 'destructive';
export type ControlParameterPrivacy = 'ordinary' | 'private-identifiers';
export type ControlChangeSource = 'local-cli' | 'agent' | 'card' | 'web';
export type ControlChangePlanStatus = 'planned' | 'confirmed' | 'applied';
export type ManagementResourceScope = 'profile' | 'root';
export type ControlPlanScalar = string | number | boolean | null;
export type ControlPlanParameters = Record<string, ControlPlanScalar>;

export type ControlChangeResource =
  | { kind: 'root' }
  | { kind: 'profile'; profile: string };

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

export interface ConfigMutation {
  root: RootConfig;
  changes: ControlChangeSummary[];
  /**
   * Explicit root teardown. The mutation kernel deletes config.json instead of
   * persisting `root`; only root-scoped commands that declare this capability
   * may return it.
   */
  deleteRoot?: boolean;
}

export interface ManagementCommandPrepareInput {
  root: RootConfig;
  profile: string;
  /** Always supplied by the mutation kernel; optional for direct legacy command tests/callers. */
  resource?: ControlChangeResource;
  parameters: ControlPlanParameters;
  /** Private execution context. Never copied into a public plan snapshot. */
  rootDir?: string;
}

export interface ManagementCommandDefinition {
  id: string;
  version: 1;
  risk: ControlChangeRisk;
  effect: ManagementRuntimeEffect;
  /** Defaults to `profile` for commands registered before resource scoping. */
  resourceScope?: ManagementResourceScope;
  /** Allows this root-scoped command to remove the root configuration. */
  allowsRootDeletion?: boolean;
  /**
   * `private-identifiers` permits command-validated resource identifiers in
   * the internal plan record. Credentials remain forbidden and public plan
   * summaries must stay redacted.
   */
  parameterPrivacy?: ControlParameterPrivacy;
  /** Pure deterministic transformation. Parameters must never contain credentials. */
  prepare(input: ManagementCommandPrepareInput): ConfigMutation;
}

/** @deprecated Compatibility input. New commands declare `effect`. */
export interface ConfigChangeOperation {
  id: string;
  version: 1;
  risk: ControlChangeRisk;
  restartRequired: boolean;
  /** Pure deterministic transformation. Parameters must never contain credentials. */
  prepare(input: ManagementCommandPrepareInput): ConfigMutation;
}

export type ManagementCommandInput = ManagementCommandDefinition | ConfigChangeOperation;

/** @deprecated Use `ConfigMutation`. */
export type ConfigChangeCandidate = ConfigMutation;

export interface ConfigChangeCommitResult {
  applyResult: ControlChangeApplyResult;
  effect: ManagementRuntimeEffect;
}

export interface ControlChangePlanSnapshot {
  schema: 'aria.control.change-plan.v1';
  apiVersion: typeof CONTROL_CHANGE_API_VERSION;
  id: string;
  profile: string;
  /** Missing only on v1 plans persisted before resource scoping shipped. */
  resource?: ControlChangeResource;
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
  | 'profile-already-exists'
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
  /** Internal effect metadata. Optional for plans persisted before the mutation kernel. */
  runtimeEffect?: ManagementRuntimeEffect;
}
