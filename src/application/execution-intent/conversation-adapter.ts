import { randomUUID } from 'node:crypto';
import type { AgentCapability } from '../../agent/capability';
import type { AccessDecision } from '../../policy/access';
import type { AgentAttachment, ScopeContext } from '../../policy/run-policy';
import {
  RUN_INTENT_CONTRACT_VERSION,
  type EngineInputRequirement,
  type RunIntent,
  type ValidatedAttachmentReference,
} from './types';
import { assertRunIntent } from './validation';

export interface CreateConversationRunIntentInput {
  intentId?: string;
  profileId: string;
  scopeId: string;
  scope: ScopeContext;
  prompt: string;
  attachments: readonly AgentAttachment[];
  access: AccessDecision;
  capability: AgentCapability;
  requestId?: string;
  idempotencyKey?: string;
}

/** Project the legacy conversation start shape into the common execution boundary. */
export function createConversationRunIntent(input: CreateConversationRunIntentInput): RunIntent {
  const intentId = input.intentId ?? randomUUID();
  const attachments = input.attachments.map(toAttachmentReference);
  const engineInputs = new Set<EngineInputRequirement>();
  if (input.prompt.trim()) engineInputs.add('text');
  for (const attachment of input.attachments) {
    if (attachment.decision !== 'accepted') continue;
    engineInputs.add(attachment.kind === 'image' ? 'image' : 'file');
  }
  const intent: RunIntent = {
    contractVersion: RUN_INTENT_CONTRACT_VERSION,
    intentId,
    profileId: input.profileId,
    sourceKind: 'channel',
    sourceIdentity: {
      providerId: input.scope.source,
    },
    idempotencyKey: input.idempotencyKey ?? intentId,
    actor: {
      kind: input.scope.actorKind ?? 'user',
      actorRef: input.scope.actorId,
    },
    authorizationRef: `conversation-access:${input.access.reason}`,
    scopeRef: input.scopeId,
    sessionPolicy: {
      kind: 'resume-anchor',
      anchorRef: input.scopeId,
    },
    input: {
      prompt: input.prompt,
      attachments,
    },
    workspaceRef: {
      kind: 'scope',
      ref: input.scopeId,
    },
    engineRequirements: {
      inputs: [...engineInputs],
      capabilities: ['agent-run'],
      preferredAgentId: input.capability.agentId,
    },
    resultRoutes: [
      {
        kind: 'conversation',
        routeId: `${intentId}:conversation`,
        conversationRef: input.scopeId,
      },
    ],
    correlation: {
      requestId: input.requestId ?? intentId,
    },
  };
  assertRunIntent(intent);
  return intent;
}

export function toAttachmentReference(
  attachment: AgentAttachment,
  index: number,
): ValidatedAttachmentReference {
  return {
    attachmentRef: attachment.hash ?? `attachment-${index + 1}`,
    kind: attachment.kind,
    requiredness: attachment.requiredness,
  };
}
