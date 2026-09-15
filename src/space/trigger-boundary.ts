import type { RunIntent } from '../application/execution-intent';
import type { TriggerDefinition } from '../trigger/state';
import type { ChannelOutboundIntent } from '../channel/plugin/types';
import { SpaceOperationLedger } from './operation-ledger';
import type { SpaceOperation } from './operation-gate';

/** Upstream trigger grants remain authoritative; this is an additional space fence. */
export class SpaceTriggerBoundary {
  constructor(readonly ledger: SpaceOperationLedger, private readonly source: { pluginId: string; instanceId: string }) {}
  async bindDefinition(definition: TriggerDefinition, operation: SpaceOperation): Promise<void> {
    const snapshot = this.ledger.gate.services.authorization.inspect(operation.context);
    const actor = definition.intentTemplate.actor;
    if (definition.profileId !== snapshot.principal.profileId || actor.actorRef !== snapshot.principal.subjectId
      || actor.kind !== (snapshot.principal.kind === 'service' ? 'system' : snapshot.principal.kind)
      || definition.intentTemplate.scopeRef !== operation.scopeRef) throw new Error('trigger owner does not match its source grant');
    await this.ledger.capture('definition:' + definition.id + ':' + definition.revision, operation, template(definition));
  }
  async authorizeIntent(intent: RunIntent): Promise<SpaceOperation> {
    const id = intent.correlation.attributes?.triggerDefinitionId;
    if (!id) throw new Error('trigger definition binding is missing');
    return this.ledger.restore('definition:' + id + ':' + intent.correlation.attributes?.triggerDefinitionRevision, {
      profileId: intent.profileId, providerId: intent.sourceIdentity.providerId, sourceKind: intent.sourceKind,
      actor: intent.actor, authorizationRef: intent.authorizationRef, scopeRef: intent.scopeRef,
      sessionPolicy: intent.sessionPolicy, input: intent.input, workspaceRef: intent.workspaceRef,
      engineRequirements: intent.engineRequirements, resultRoutes: intent.resultRoutes,
    });
  }
  async bindResult(definition: TriggerDefinition, intent: ChannelOutboundIntent): Promise<void> {
    const operation = await this.ledger.restore('definition:' + definition.id + ':' + definition.revision, template(definition));
    if (intent.pluginId !== this.source.pluginId || intent.instanceId !== this.source.instanceId
      || intent.profileId !== definition.profileId || intent.scopeId !== operation.scopeRef
      || intent.instanceId !== this.ledger.gate.services.authorization.inspect(operation.context).binding.conversation.instanceId) throw new Error('trigger result destination differs from its original source');
    await this.ledger.capture('delivery:' + intent.deliveryId, operation, intent);
  }
  async deliver<T>(intent: ChannelOutboundIntent, send: () => Promise<T>): Promise<T> {
    const operation = await this.ledger.restore('delivery:' + intent.deliveryId, intent);
    return this.ledger.gate.run(operation, () => this.ledger.gate.deliver(operation.request.conversationId, send));
  }
}
function template(definition: TriggerDefinition) {
  return { profileId: definition.profileId, providerId: definition.providerId, sourceKind: definition.sourceKind,
    ...definition.intentTemplate };
}
