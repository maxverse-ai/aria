import type { ChannelInboundEnvelope, ChannelOutboundIntent } from '../plugin/types';
import type { ChannelIdentityRequest } from '../identity/types';
import { SpaceOperationLedger } from '../../space/operation-ledger';
import { channelReliabilityKey, reliabilityKeyFromEnvelope } from './key';

export interface ChannelSpaceBoundary {
  accept(envelope: ChannelInboundEnvelope): Promise<void>;
  execute(envelopes: readonly ChannelInboundEnvelope[], process: () => Promise<readonly ChannelOutboundIntent[]>): Promise<readonly ChannelOutboundIntent[]>;
  deliver<T>(intent: ChannelOutboundIntent, send: () => Promise<T>): Promise<T>;
}

/** Created by authenticated channel composition, never from actor hints in content. */
export class BoundChannelReliability implements ChannelSpaceBoundary {
  constructor(readonly ledger: SpaceOperationLedger,
    private readonly source: { profileId: string; pluginId: string; instanceId: string;
      identity(envelope: ChannelInboundEnvelope): ChannelIdentityRequest }) {}
  async accept(envelope: ChannelInboundEnvelope): Promise<void> {
    this.assertSource(envelope);
    const key = 'inbound:' + channelReliabilityKey(reliabilityKeyFromEnvelope(envelope));
    if (this.ledger.has(key)) { await this.ledger.restore(key, envelope); return; }
    const operation = await this.ledger.gate.enter(this.source.identity(envelope), envelope.scopeId);
    await this.ledger.capture(key, operation, envelope);
  }
  async execute(envelopes: readonly ChannelInboundEnvelope[], process: () => Promise<readonly ChannelOutboundIntent[]>): Promise<readonly ChannelOutboundIntent[]> {
    const operations = await Promise.all(envelopes.map((envelope) => {
      this.assertSource(envelope);
      return this.ledger.restore('inbound:' + channelReliabilityKey(reliabilityKeyFromEnvelope(envelope)), envelope);
    }));
    const operation = await this.ledger.gate.batch(operations);
    return this.ledger.gate.run(operation, async () => {
      const intents = await process();
      for (const intent of intents) {
        this.assertSource(intent);
        if (intent.scopeId !== operation.scopeRef) throw new Error('answer has a foreign destination');
        await this.ledger.capture('outbound:' + intent.deliveryId, operation, intent);
      }
      return intents;
    });
  }
  async deliver<T>(intent: ChannelOutboundIntent, send: () => Promise<T>): Promise<T> {
    this.assertSource(intent);
    const operation = await this.ledger.restore('outbound:' + intent.deliveryId, intent);
    return this.ledger.gate.run(operation, () => this.ledger.gate.deliver(operation.request.conversationId, send));
  }
  private assertSource(value: { profileId: string; pluginId: string; instanceId: string }): void {
    if (value.profileId !== this.source.profileId || value.pluginId !== this.source.pluginId || value.instanceId !== this.source.instanceId) throw new Error('channel account binding mismatch');
  }
}
