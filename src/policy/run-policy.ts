import { evaluateEffectivePolicy } from './effective-policy';
import { legacyEnginePermissions } from '../agent/permission-policy';
import type { AgentCapability } from '../agent/capability';
import {
  type AccessMode,
  type ClaudePermissionMode,
  type CodexSandboxMode,
} from '../config/permissions';
import type { EngineProfileConfig } from '../config/profile-schema';
import type { ConversationSource } from '../conversation/types';
import type { AccessDecision } from './access';
import {
  accessPolicyDigest,
  attachmentPolicyConfigDigest,
  policyFingerprint,
  resourceScopeDigest,
} from './fingerprint';

export interface ScopeContext {
  source: ConversationSource;
  chatId?: string;
  threadId?: string;
  actorId: string;
  actorKind?: 'user' | 'system' | 'agent';
  commentScopeId?: string;
  resourceBindings?: ResourceBinding[];
}

export interface ResourceBinding {
  kind: 'doc' | 'folder';
  id: string;
  verified: boolean;
}

export interface AgentAttachment {
  kind: string;
  requiredness: 'required' | 'optional';
  decision: 'accepted' | 'rejected' | 'skipped';
  rejectionReason?: string;
  originalName?: string;
  size?: number;
  hash?: string;
  path?: string;
}

export interface RunPolicyInput {
  scope: ScopeContext;
  attachments: AgentAttachment[];
  prompt: string;
  requestedCwd: string;
  cwdRealpath: string;
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: EngineProfileConfig;
  now: number;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ttlMs?: number;
}

export interface RunPolicyAllow {
  ok: true;
  prompt: string;
  requestedCwd: string;
  cwdRealpath: string;
  accessMode: AccessMode;
  sandbox: CodexSandboxMode;
  permissionMode: ClaudePermissionMode;
  access: AccessDecision;
  attachments: AgentAttachment[];
  policyFingerprint: string;
  expiresAt: number;
}

export interface RunPolicyReject {
  ok: false;
  rejectReason: {
    code:
      | 'access-denied'
      | 'folder-allowlist-unverified'
      | 'required-attachment-rejected';
    userVisible: string;
  };
}

export type RunPolicyResult = RunPolicyAllow | RunPolicyReject;

/** Compatibility facade preserving v1 run fields and persisted fingerprints. */
export function evaluateRunPolicy(input: RunPolicyInput): RunPolicyResult {
  const decision = evaluateEffectivePolicy({
    admitted: input.access,
    defaultAccess: input.profileConfig.permissions.defaultAccess,
    profileCeiling: input.profileConfig.permissions.maxAccess,
    engineCeiling: input.capability.permissions.maxAccess,
    hasUnverifiedFolder: input.scope.resourceBindings?.some(
      (binding) => binding.kind === 'folder' && !binding.verified,
    ) ?? false,
    hasRejectedRequiredAttachment: input.attachments.some(
      (attachment) => attachment.requiredness === 'required' && attachment.decision !== 'accepted',
    ),
    now: input.now,
    ttlMs: input.ttlMs,
  });
  if (!decision.ok) {
    const messages = {
      'access-denied': '当前用户无权发起运行。',
      'folder-allowlist-unverified': '暂不支持 folder allowlist，已拒绝运行。',
      'required-attachment-rejected': '必需附件未通过校验，已拒绝运行。',
    };
    return reject(decision.code, messages[decision.code]);
  }
  const { accessMode, expiresAt } = decision.policy;
  const { sandbox, permissionMode } = legacyEnginePermissions(decision.policy, input.profileConfig.permissions);
  const resourceDigest = resourceScopeDigest({
    source: input.scope.source,
    chatId: input.scope.chatId,
    threadId: input.scope.threadId,
    commentScopeId: input.scope.commentScopeId,
    resourceBindings: input.scope.resourceBindings?.map((binding) => binding.id),
  });
  const attachmentDigest = attachmentPolicyConfigDigest(input.profileConfig.attachments);
  const accessDigest =
    input.scope.source === 'comment' && input.access.reason === 'comment-mention'
      ? 'comment-mention'
      : accessPolicyDigest(input.profileConfig.access);

  return {
    ok: true,
    prompt: input.prompt,
    requestedCwd: input.requestedCwd,
    cwdRealpath: input.cwdRealpath,
    accessMode,
    sandbox,
    permissionMode,
    access: input.access,
    attachments: input.attachments,
    expiresAt,
    policyFingerprint: policyFingerprint({
      cwdRealpath: input.cwdRealpath,
      sandbox,
      accessPolicyDigest: accessDigest,
      resourceScopeDigest: resourceDigest,
      attachmentPolicyShapeDigest: attachmentDigest,
      codexHome: input.codexHome,
      inheritCodexHome: input.inheritCodexHome ?? false,
    }),
  };
}

function reject(code: RunPolicyReject['rejectReason']['code'], userVisible: string): RunPolicyReject {
  return {
    ok: false,
    rejectReason: {
      code,
      userVisible,
    },
  };
}
