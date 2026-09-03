import type { AgentKind, LarkCliIdentityPreset, ProfileMode } from '../../config/profile-schema';
import type { CotMessagesMode, MessageReplyMode, TenantBrand } from '../../config/schema';

export const CONTROL_API_VERSION = 1 as const;

export type ControlAccess = 'read' | 'write';

export interface ControlCapability {
  id:
    | 'control.capabilities'
    | 'profile.show'
    | 'config.show'
    | 'config.settings'
    | 'config.plan'
    | 'config.plan.show'
    | 'config.plan.confirm'
    | 'config.plan.apply'
    | 'trigger.capabilities'
    | 'trigger.schema'
    | 'runtime.status';
  cli: string;
  access: ControlAccess;
  outputs: readonly ['text', 'json'];
}

export interface ControlCapabilitiesSnapshot {
  schema: 'aria.control.capabilities.v1';
  apiVersion: typeof CONTROL_API_VERSION;
  capabilities: ControlCapability[];
}

export interface ProfileSummarySnapshot {
  schema: 'aria.control.profile.v1';
  apiVersion: typeof CONTROL_API_VERSION;
  profile: {
    name: string;
    active: boolean;
    schemaVersion: 2 | 3;
  };
  agent: {
    kind: AgentKind;
  };
  deployment: {
    mode: ProfileMode;
  };
  application: {
    tenant: TenantBrand;
  };
  runtime: {
    registeredProcesses: number;
    locked: boolean;
  };
}

export interface ConfigSnapshot {
  schema: 'aria.control.config.v1';
  apiVersion: typeof CONTROL_API_VERSION;
  revision: string;
  profile: {
    name: string;
    active: boolean;
    schemaVersion: 2 | 3;
  };
  agent: {
    kind: AgentKind;
    model: string;
    reasoningEffort: string | null;
    /** `inherit`, `standard`, or an engine-native tier id such as `fast`. */
    serviceTier: string;
    plugins: string[];
  };
  deployment: {
    mode: ProfileMode;
  };
  access: {
    allowedUsers: number;
    allowedChats: number;
    admins: number;
    requireMentionInGroup: boolean;
    chatMentionOverrides: number;
  };
  identity: {
    storedLarkCliPreset: LarkCliIdentityPreset;
    effectiveLarkCliPreset: LarkCliIdentityPreset;
    localUserImportStatus: string | null;
  };
  workspace: {
    defaultConfigured: boolean;
  };
  presentation: {
    messageReply: MessageReplyMode;
    showToolCalls: boolean;
    cotMessages: CotMessagesMode;
  };
  execution: {
    maxConcurrentRuns: number;
    runIdleTimeoutMs: number | null;
    agentStopGraceMs: number;
  };
  meeting: {
    enabled: boolean;
  };
}

export interface RuntimeStatusSnapshot {
  schema: 'aria.control.runtime.v1';
  apiVersion: typeof CONTROL_API_VERSION;
  profile: string;
  lock: {
    locked: boolean;
    uncertain: boolean;
    holder?: {
      pid: number;
      agentKind: AgentKind;
      startedAt: string;
    };
  };
  processes: Array<{
    id: string;
    pid: number;
    agentKind: AgentKind;
    startedAt: string;
    version: string;
    alive: boolean;
    botName?: string;
  }>;
}
