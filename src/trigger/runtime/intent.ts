import {
  RUN_INTENT_CONTRACT_VERSION,
  assertRunIntent,
  type RunIntent,
} from '../../application/execution-intent';
import type { TriggerDefinition, TriggerOccurrence } from '../state';

/** Resolve a durable template into one immutable execution request. */
export function createTriggerRunIntent(
  definition: TriggerDefinition,
  occurrence: TriggerOccurrence,
  intentId: string,
): RunIntent {
  const intent: RunIntent = {
    contractVersion: RUN_INTENT_CONTRACT_VERSION,
    intentId,
    profileId: definition.profileId,
    sourceKind: definition.sourceKind,
    sourceIdentity: {
      providerId: definition.providerId,
      sourceEventId: occurrence.metadata.sourceEventId ?? occurrence.id,
    },
    idempotencyKey: occurrence.idempotencyKey,
    actor: structuredClone(definition.intentTemplate.actor),
    authorizationRef: definition.intentTemplate.authorizationRef,
    scopeRef: definition.intentTemplate.scopeRef,
    sessionPolicy: structuredClone(definition.intentTemplate.sessionPolicy),
    input: structuredClone(definition.intentTemplate.input),
    workspaceRef: structuredClone(definition.intentTemplate.workspaceRef),
    engineRequirements: structuredClone(definition.intentTemplate.engineRequirements),
    resultRoutes: structuredClone(definition.intentTemplate.resultRoutes),
    correlation: {
      requestId: occurrence.id,
      attributes: {
        triggerDefinitionId: definition.id,
        triggerOccurrenceId: occurrence.id,
        scheduledFor: String(occurrence.scheduledFor),
        ...(occurrence.metadata.sourceEventId
          ? { sourceEventId: occurrence.metadata.sourceEventId }
          : {}),
      },
    },
  };
  assertRunIntent(intent);
  return intent;
}
