import type { ControlActorContext } from '../../application/control';
import type { ScheduleSpec } from '../schedule';
import type { TriggerDefinition, TriggerOccurrence } from '../state';

export const TRIGGER_MANAGEMENT_API_VERSION = 1 as const;

export type TriggerManagementCommand =
  | 'create'
  | 'update'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'run-now'
  | 'retry'
  | 'ack';

export interface TriggerManagementContext {
  apiVersion: typeof TRIGGER_MANAGEMENT_API_VERSION;
  requestId: string;
  actor: ControlActorContext;
}

export interface TriggerPlanRequest extends TriggerManagementContext {
  schema: 'aria.trigger-management.plan.request.v1';
  command: TriggerManagementCommand;
  input: Record<string, unknown>;
}

export interface TriggerPlanActionRequest extends TriggerManagementContext {
  schema: 'aria.trigger-management.plan-action.request.v1';
  planId: string;
}

export interface TriggerExecuteRequest extends TriggerManagementContext {
  schema: 'aria.trigger-management.execute.request.v1';
  command: TriggerManagementCommand;
  input: Record<string, unknown>;
}

export interface TriggerPlanSnapshot {
  schema: 'aria.trigger-management.plan.v1';
  apiVersion: typeof TRIGGER_MANAGEMENT_API_VERSION;
  id: string;
  command: TriggerManagementCommand;
  status: 'planned' | 'confirmed' | 'applied';
  actor: { source: ControlActorContext['source']; fingerprint: string };
  summary: readonly { field: string; before: string | number | boolean | null; after: string | number | boolean | null }[];
  createdAt: string;
  expiresAt: string;
  confirmedAt?: string;
  appliedAt?: string;
}

export interface TriggerPlanResult {
  schema: 'aria.trigger-management.plan-result.v1';
  apiVersion: typeof TRIGGER_MANAGEMENT_API_VERSION;
  requestId: string;
  plan: TriggerPlanSnapshot;
}

export interface TriggerApplyResult {
  schema: 'aria.trigger-management.apply.v1';
  apiVersion: typeof TRIGGER_MANAGEMENT_API_VERSION;
  requestId: string;
  planId: string;
  command: TriggerManagementCommand;
  definition?: TriggerDefinitionReadModel;
  occurrence?: TriggerOccurrence;
}

/** Public projection: task text, grants, raw owners and conversation anchors stay private. */
export type TriggerDefinitionReadModel = Omit<
  TriggerDefinition,
  'ownerRef' | 'createdBy' | 'authorizationGrantRef' | 'intentTemplate'
> & {
  owner: { fingerprint: string };
  createdBy: { kind: TriggerDefinition['createdBy']['kind']; actorFingerprint: string };
  authorizationGrant: '[REDACTED]';
  intent: {
    scopeFingerprint: string;
    sessionPolicy: TriggerDefinition['intentTemplate']['sessionPolicy'];
    input: { prompt: '[REDACTED]'; attachmentCount: number };
    workspaceRef: TriggerDefinition['intentTemplate']['workspaceRef'];
    engineRequirements: TriggerDefinition['intentTemplate']['engineRequirements'];
    resultRoutes: readonly { kind: 'history' | 'conversation' | 'none' | 'multi'; routeId: string }[];
  };
};

export interface TriggerReadSnapshot {
  schema: 'aria.trigger-read.snapshot.v1';
  apiVersion: typeof TRIGGER_MANAGEMENT_API_VERSION;
  generatedAt: string;
  definitions: readonly TriggerDefinitionReadModel[];
  occurrences: readonly TriggerOccurrence[];
}

export interface TriggerPreviewSnapshot {
  schema: 'aria.trigger-read.preview.v1';
  apiVersion: typeof TRIGGER_MANAGEMENT_API_VERSION;
  definitionId: string;
  schedule: ScheduleSpec;
  timeZone: string;
  fireTimes: readonly number[];
}

export class TriggerManagementError extends Error {
  constructor(
    readonly code:
      | 'invalid-request'
      | 'plan-not-found'
      | 'plan-expired'
      | 'actor-mismatch'
      | 'not-confirmed'
      | 'definition-not-found'
      | 'occurrence-not-found',
    message: string,
  ) {
    super(message);
    this.name = 'TriggerManagementError';
  }
}

export interface StoredTriggerPlan extends TriggerPlanSnapshot {
  input: Record<string, unknown>;
}
