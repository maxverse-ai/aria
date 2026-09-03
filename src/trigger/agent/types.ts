import type { ControlActorContext } from '../../application/control';
import type { TriggerDefinitionReadModel, TriggerReadSnapshot } from '../operations';

export const AGENT_TRIGGER_GRANT_CAPABILITY = 'scheduled-triggers' as const;

export interface AgentTriggerGrantLimits {
  maxActiveDefinitions: number;
  maxRunsPerDay: number;
  maxRuntimeMs: number;
  maxPromptBytes: number;
  allowedScheduleKinds: readonly ('once' | 'daily' | 'weekly')[];
}

export interface AgentTriggerGrantRecord {
  schemaVersion: 1;
  id: string;
  capability: typeof AGENT_TRIGGER_GRANT_CAPABILITY;
  state: 'active' | 'revoked';
  profileId: string;
  engineId: string;
  principal: string;
  tokenDigest: string;
  limits: AgentTriggerGrantLimits;
  issuedByFingerprint: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export type AgentTriggerGrantView = Omit<
  AgentTriggerGrantRecord,
  'principal' | 'tokenDigest' | 'issuedByFingerprint'
> & {
  principalFingerprint: string;
  issuedBy: { fingerprint: string };
};

export interface AgentTriggerGrantIssueInput {
  profileId: string;
  engineId: string;
  principal: string;
  expiresAt: string;
  limits?: Partial<AgentTriggerGrantLimits>;
}

export interface AgentTriggerGrantIssueResult {
  schema: 'aria.agent-trigger-grant.issue.v1';
  apiVersion: 1;
  grant: AgentTriggerGrantView;
  /** Returned once. Only the digest is persisted. */
  token: string;
}

export type AgentTriggerCommand = 'create' | 'list' | 'history' | 'snooze' | 'update' | 'cancel';

export interface AgentTriggerRequest {
  schema: 'aria.agent-trigger.execute.request.v1';
  apiVersion: 1;
  requestId: string;
  grantToken: string;
  engineId: string;
  command: AgentTriggerCommand;
  input: Record<string, unknown>;
}

export interface AgentTriggerResult {
  schema: 'aria.agent-trigger.execute.result.v1';
  apiVersion: 1;
  requestId: string;
  command: AgentTriggerCommand;
  definition?: TriggerDefinitionReadModel;
  snapshot?: TriggerReadSnapshot;
}

export interface AgentTriggerGrantAdmin {
  issue(input: AgentTriggerGrantIssueInput, actor: ControlActorContext): Promise<AgentTriggerGrantIssueResult>;
  revoke(id: string, actor: ControlActorContext): Promise<AgentTriggerGrantView>;
}
