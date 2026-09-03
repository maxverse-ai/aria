export const RUN_INTENT_CONTRACT_VERSION = 1 as const;
export const TRIGGER_CONTROL_API_VERSION = 1 as const;

export type RunIntentSourceKind =
  | 'channel'
  | 'schedule'
  | 'manual'
  | 'webhook'
  | 'internal-event';

export type RunIntentActorKind = 'user' | 'system' | 'agent';

export interface RunIntentSourceIdentity {
  providerId: string;
  sourceEventId?: string;
}

export interface RunIntentActor {
  kind: RunIntentActorKind;
  actorRef: string;
}

export type SessionPolicy =
  | { kind: 'fresh' }
  | { kind: 'resume-anchor'; anchorRef: string }
  | { kind: 'named-session'; name: string }
  | { kind: 'stateless' };

export type WorkspaceReference =
  | { kind: 'scope'; ref: string }
  | { kind: 'profile-default' }
  | { kind: 'named'; ref: string };

export interface ValidatedAttachmentReference {
  attachmentRef: string;
  kind: string;
  requiredness: 'required' | 'optional';
}

export type EngineInputRequirement = 'text' | 'image' | 'file';

export interface EngineCapabilityRequirements {
  inputs: readonly EngineInputRequirement[];
  capabilities: readonly string[];
  preferredAgentId?: string;
}

export interface HistoryResultRoute {
  kind: 'history';
  routeId: string;
}

export interface ConversationResultRoute {
  kind: 'conversation';
  routeId: string;
  conversationRef: string;
}

export interface NoResultRoute {
  kind: 'none';
  routeId: string;
}

export type LeafResultRoute =
  | HistoryResultRoute
  | ConversationResultRoute
  | NoResultRoute;

export interface MultiResultRoute {
  kind: 'multi';
  routeId: string;
  routes: readonly LeafResultRoute[];
}

export type ResultRoute = LeafResultRoute | MultiResultRoute;

export interface RunIntentCorrelation {
  requestId: string;
  parentIntentId?: string;
  attributes?: Readonly<Record<string, string>>;
}

/**
 * Stable, serializable request accepted by profile execution coordination.
 * Provider-native payloads, credentials, and unvalidated local paths do not
 * belong in this contract.
 */
export interface RunIntent {
  contractVersion: typeof RUN_INTENT_CONTRACT_VERSION;
  intentId: string;
  profileId: string;
  sourceKind: RunIntentSourceKind;
  sourceIdentity: RunIntentSourceIdentity;
  idempotencyKey: string;
  actor: RunIntentActor;
  authorizationRef: string;
  scopeRef: string;
  sessionPolicy: SessionPolicy;
  input: {
    prompt: string;
    attachments: readonly ValidatedAttachmentReference[];
  };
  workspaceRef: WorkspaceReference;
  engineRequirements: EngineCapabilityRequirements;
  resultRoutes: readonly ResultRoute[];
  correlation: RunIntentCorrelation;
}

export type TriggerContractSchemaName =
  | 'run-intent'
  | 'result-route'
  | 'session-policy'
  | 'trigger-provider-manifest'
  | 'trigger-envelope'
  | 'schedule-spec';

export interface TriggerCapabilitySnapshot {
  schema: 'aria.trigger.capabilities.v1';
  apiVersion: typeof TRIGGER_CONTROL_API_VERSION;
  implementationStage: string;
  runtimeEnabled: boolean;
  capabilities: Array<{
    id: 'trigger.capabilities' | 'trigger.schema';
    cli: string;
    access: 'read';
    outputs: readonly ['text', 'json'];
  }>;
}

export interface TriggerContractSchemaSnapshot {
  schema: 'aria.trigger.contract-schema.v1';
  apiVersion: typeof TRIGGER_CONTROL_API_VERSION;
  name: TriggerContractSchemaName;
  contractVersion: typeof RUN_INTENT_CONTRACT_VERSION;
  jsonSchema: Readonly<Record<string, unknown>>;
}
