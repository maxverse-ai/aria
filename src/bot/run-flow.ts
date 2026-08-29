import type { AgentCapability } from '../agent/capability';
import { resolveModelArg } from '../agent/models';
import type { AgentEvent } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';
import type { AccessDecision } from '../policy/access';
import {
  evaluateRunPolicy,
  type AgentAttachment,
  type RunPolicyAllow,
  type RunPolicyReject,
  type ScopeContext,
} from '../policy/run-policy';
import { recordRunPolicyDecision } from '../policy/run-policy-audit';
import {
  resolveWorkingDirectory,
  type WorkingDirectoryRejectReason,
  type WorkingDirectoryResolveResult,
} from '../policy/workspace';
import type { RunExecution, RunExecutor } from '../runtime/run-executor';
import type { GovernanceAuditEvent, GovernanceAuditSink } from '../runtime/governance-audit';
import { RunRejected, type RunRejectedCode } from '../runtime/errors';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { log } from '../core/logger';
import { observabilityFields } from '../observability/execution-context';

export interface StartRunFlowInput {
  scopeId: string;
  scope: ScopeContext;
  prompt: string;
  attachments: AgentAttachment[];
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: ProfileConfig;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  executor: RunExecutor;
  governanceAudit?: GovernanceAuditSink;
  now: number;
  /** Pre-validated engine-native effort; null explicitly means omit it. */
  reasoningEffort?: string | null;
  /** Pre-validated service tier; null explicitly selects the standard tier. */
  serviceTier?: string | null;
  stopGraceMs?: number;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export type RunFlowRejectCode =
  | WorkingDirectoryRejectReason
  | RunPolicyReject['rejectReason']['code']
  | RunRejectedCode;

export type StartRunFlowResult =
  | {
      ok: true;
      execution: RunExecution;
      policy: RunPolicyAllow;
      cwdRealpath: string;
      resumeFrom?: string;
    }
  | {
      ok: false;
      rejectReason: {
        code: RunFlowRejectCode;
        userVisible: string;
      };
      workspace?: WorkingDirectoryResolveResult;
    };

export interface RecordRunSessionEventInput {
  scopeId: string;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  capability: AgentCapability;
  policy: RunPolicyAllow;
  event: AgentEvent;
}

export async function startRunFlow(input: StartRunFlowInput): Promise<StartRunFlowResult> {
  const requestedCwd =
    input.workspaces.cwdFor(input.scopeId) ?? input.profileConfig.workspaces.default ?? '';
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    return {
      ok: false,
      rejectReason: {
        code: workspace.reason,
        userVisible: workspace.userVisible,
      },
      workspace,
    };
  }

  const policy = evaluateRunPolicy({
    scope: input.scope,
    attachments: input.attachments,
    prompt: input.prompt,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability: input.capability,
    profileConfig: input.profileConfig,
    now: input.now,
    codexHome: input.profileConfig.codex?.codexHome,
    inheritCodexHome: input.profileConfig.codex?.inheritCodexHome,
  });
  await recordRunPolicyDecision({
    sink: input.governanceAudit,
    policy,
    eventId: `${input.scopeId}:${input.now}:policy`,
    occurredAt: new Date(input.now).toISOString(),
    actorSourceId: input.scope.actorId,
    conversationSourceId: input.scopeId,
    deniedTargetSourceId: `${input.scopeId}:run-policy`,
  });
  if (!policy.ok) {
    return {
      ok: false,
      rejectReason: policy.rejectReason,
      workspace,
    };
  }

  let resumeFrom: string | undefined;
  let sessionId: string | undefined;
  let threadId: string | undefined;
  if (input.sessionCatalog) {
    const catalogEntry = input.sessionCatalog.activeFor({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
    });
    if (catalogEntry?.sessionId) {
      sessionId = catalogEntry.sessionId;
      resumeFrom = sessionId;
    } else if (catalogEntry?.threadId) {
      threadId = catalogEntry.threadId;
      resumeFrom = threadId;
    }
  }
  if (!resumeFrom && input.capability.agentId === 'claude') {
    resumeFrom = input.sessions.resumeFor(input.scopeId, workspace.cwdRealpath);
    sessionId = resumeFrom;
    const stale = input.sessions.getRaw(input.scopeId);
    if (!resumeFrom && stale?.cwd && stale.cwd !== workspace.cwdRealpath) {
      input.sessions.clear(input.scopeId);
    }
  }

  log.info('session', 'resolved', {
    ...observabilityFields(),
    profile: input.observability?.profile ?? 'unknown',
    agent: input.observability?.agent ?? input.capability.agentId,
    scope: input.scopeId,
    source: input.observability?.source ?? input.scope.source,
    resolution: resumeFrom ? 'resumed' : 'fresh',
    sessionKind: input.capability.sessionKind,
    sessionId: resumeFrom,
  });

  let execution: RunExecution;
  try {
    execution = await input.executor.submit({
      scopeId: input.scopeId,
      policy,
      sessionId,
      threadId,
      model: resolveModelArg(
        input.profileConfig.agentKind,
        input.profileConfig.preferences.model,
      ),
      reasoningEffort:
        input.reasoningEffort === null
          ? undefined
          : input.reasoningEffort ?? input.profileConfig.preferences.reasoningEffort,
      serviceTier: input.capability.supportsServiceTiers
        ? Object.prototype.hasOwnProperty.call(input, 'serviceTier')
          ? input.serviceTier
          : input.profileConfig.preferences.serviceTier
        : undefined,
      images:
        input.capability.supportsImages === true
          ? policy.attachments
              .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
              .map((attachment) => attachment.path)
              .filter((path): path is string => Boolean(path))
          : undefined,
      stopGraceMs: input.stopGraceMs,
      observability: input.observability,
    });
    await Promise.all(policy.attachments
      .filter((attachment) => attachment.decision === 'accepted')
      .map((attachment, index) => recordGovernance(input.governanceAudit, {
        eventId: `${execution.runId}:attachment:${attachment.hash ?? index}:read`,
        action: 'attachment.read',
        occurredAt: new Date(input.now).toISOString(),
        outcome: 'success',
        actorKind: 'system',
        actorSourceId: input.scope.actorId,
        conversationSourceId: input.scopeId,
        sourceRunId: execution.runId,
        targetSourceId: attachment.hash ?? `${input.scopeId}:${index}`,
      })));
  } catch (err) {
    if (err instanceof RunRejected) {
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible:
            err.code === 'reconnect-in-progress'
              ? '当前 bot 正在重连，稍后会继续处理新消息。'
              : err.code === 'run-already-active'
                ? '当前会话已有运行在执行，请稍后再试或先停止当前运行。'
              : '当前无法发起运行，请稍后重试。',
        },
        workspace,
      };
    }
    throw err;
  }

  return {
    ok: true,
    execution,
    policy,
    cwdRealpath: workspace.cwdRealpath,
    ...(resumeFrom ? { resumeFrom } : {}),
  };
}

async function recordGovernance(
  sink: GovernanceAuditSink | undefined,
  event: GovernanceAuditEvent,
): Promise<void> {
  if (!sink) return;
  await sink.record(event).catch((err) =>
    log.warn('governance', 'audit-write-failed', {
      action: event.action,
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}

export function recordRunSessionEvent(input: RecordRunSessionEventInput): void {
  const { event, capability } = input;
  if (event.type !== 'system' && event.type !== 'done') return;
  if (capability.sessionKind !== 'codex-thread') {
    if (!event.sessionId) return;
    const cwdRealpath = event.type === 'system' && event.cwd
      ? event.cwd
      : input.policy.cwdRealpath;
    input.sessions.set(input.scopeId, event.sessionId, cwdRealpath);
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: capability.agentId,
      cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      sessionId: event.sessionId,
    });
    return;
  }
  if (event.threadId) {
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: capability.agentId,
      cwdRealpath: input.policy.cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      threadId: event.threadId,
    });
  }
}
