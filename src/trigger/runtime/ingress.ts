import { randomUUID } from 'node:crypto';
import {
  assertTriggerEnvelope,
  type TriggerEnvelope,
  type TriggerIngressAcceptance,
  type TriggerIngressPort,
} from '../plugin';
import {
  createPendingSourceOccurrence,
  type TriggerDefinition,
  type TriggerStateStore,
} from '../state';

export type TriggerIngressErrorCode =
  | 'definition-required'
  | 'definition-not-found'
  | 'definition-inactive'
  | 'source-binding-mismatch'
  | 'schedule-ingress-unsupported';

export class TriggerIngressError extends Error {
  constructor(readonly code: TriggerIngressErrorCode, message: string) {
    super(message);
    this.name = 'TriggerIngressError';
  }
}

export interface TriggerIngressCoordinatorOptions {
  store: TriggerStateStore;
  now?: () => number;
  createId?: () => string;
  /** Advisory wake-up after a durable first acceptance. */
  onAccepted?: () => Promise<void> | void;
}

/**
 * Core-owned acceptance boundary for push and poll providers.
 * Provider evidence selects an existing definition; it never supplies authority
 * or executable input. Acknowledgement follows durable occurrence creation.
 */
export class TriggerIngressCoordinator implements TriggerIngressPort {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: TriggerIngressCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  async accept(envelope: TriggerEnvelope): Promise<TriggerIngressAcceptance> {
    assertTriggerEnvelope(envelope);
    if (envelope.sourceKind === 'schedule') {
      throw ingressError('schedule-ingress-unsupported', 'schedule events are materialized by the host clock');
    }
    if (!envelope.triggerDefinitionId) {
      throw ingressError('definition-required', 'external trigger envelope requires triggerDefinitionId');
    }
    const definition = await this.options.store.getDefinition(envelope.triggerDefinitionId);
    if (!definition) throw ingressError('definition-not-found', 'trigger definition was not found');
    if (definition.state !== 'active') {
      throw ingressError('definition-inactive', 'trigger definition is not active');
    }
    assertBinding(definition, envelope);

    const acceptedAt = this.now();
    const occurrence = createPendingSourceOccurrence({
      id: this.createId(),
      profileId: definition.profileId,
      providerId: definition.providerId,
      instanceId: definition.instanceId,
      definitionId: definition.id,
      definitionRevision: definition.revision,
      sourceEventId: envelope.sourceEventId,
      acceptedAt,
      occurredAt: envelope.occurredAt,
    });
    const result = await this.options.store.materialize({
      definitionId: definition.id,
      expectedRevision: definition.revision,
      sourceEventId: envelope.sourceEventId,
      occurrence,
      advancedAt: acceptedAt,
    });
    if (result.status === 'created') {
      await Promise.resolve(this.options.onAccepted?.()).catch(() => undefined);
    }
    return {
      status: result.status === 'created' ? 'accepted' : 'duplicate',
      receiptId: `occurrence:${result.occurrence.id}`,
    };
  }
}

function assertBinding(definition: TriggerDefinition, envelope: TriggerEnvelope): void {
  const matches = definition.profileId === envelope.profileId
    && definition.providerId === envelope.providerId
    && definition.instanceId === envelope.instanceId
    && definition.sourceKind === envelope.sourceKind
    && definition.intentTemplate.scopeRef === envelope.scopeRef;
  if (!matches) {
    throw ingressError('source-binding-mismatch', 'trigger envelope does not match its durable definition binding');
  }
}

function ingressError(code: TriggerIngressErrorCode, message: string): TriggerIngressError {
  return new TriggerIngressError(code, message);
}
