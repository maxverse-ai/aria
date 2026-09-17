import type { CotClient, CotEvent, CotRef } from '../bot/cot';
import type { SpaceOperation, SpaceOperationGate } from '../space/operation-gate';
import type { ProgressReceipt } from '../space/resources';
import { checkProgress, type ProgressPolicy } from './progress-policy';
import type { OutboundPolicyContext } from './plugin';

/** A run owns its transport, not a mutable profile-wide current space. Provider
 * IDs are usable only after this transport records their host-owned receipt. */
export class BoundCotClient {
  private readonly refs = new Map<string, ProgressReceipt>();
  private closed = false;
  constructor(private readonly input: {
    client: Pick<CotClient, 'create' | 'update' | 'complete'>;
    gate: SpaceOperationGate; operation: SpaceOperation;
    policy?: ProgressPolicy; policyRequired: boolean; context: OutboundPolicyContext;
  }) {}

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    const { gate, operation, client } = this.input;
    if (chatId !== operation.request.conversationId || !originMessageId
      || originMessageId !== this.input.context.sourceMessageId) throw new Error('foreign CoT destination or origin');
    gate.resources.assert(operation.context, 'message', originMessageId);
    const owner = gate.resources.captureProgressOwner(operation.context);
    return this.deliver('create', { receive_id: chatId, origin_message_id: originMessageId }, async () => {
      const result = await client.create(chatId, originMessageId);
      const cotId = result.cot_id ?? result.cotId;
      const messageId = result.message_id ?? result.messageId;
      if (typeof cotId !== 'string' || typeof messageId !== 'string') throw new Error('CoT response lacks receipt');
      const receipt = await gate.resources.recordProgress(owner, { format: 'cot', cotId, messageId });
      this.refs.set(messageId, receipt);
      return result;
    });
  }

  async update(ref: CotRef, events: readonly CotEvent[]): Promise<void> {
    const receipt = this.receipt(ref);
    const { gate, operation } = this.input;
    gate.resources.assertProgress(operation.context, receipt);
    await this.deliver('update', { cot_id: ref.cotId, message_id: ref.messageId, events },
      () => this.input.client.update(ref, events));
  }

  async complete(ref: CotRef, reason: string): Promise<void> {
    const receipt = this.receipt(ref);
    try {
      await this.deliver('complete', { reason }, () => this.input.client.complete(ref, reason));
      await this.finish(receipt);
    } catch {
      // Revocation never permits another content update. An opaque, previously
      // minted receipt permits only this fixed no-content terminal operation.
      await this.terminate(receipt);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const receipt of [...this.refs.values()]) await this.terminate(receipt);
  }

  private receipt(ref: CotRef): ProgressReceipt {
    const receipt = this.refs.get(ref.messageId);
    if (!receipt || receipt.cotId !== ref.cotId) throw new Error('foreign CoT receipt');
    return receipt;
  }
  private async deliver<T>(phase: 'create' | 'update' | 'complete', payload: unknown, send: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('CoT delivery is closed');
    const { gate, operation, context, policy, policyRequired } = this.input;
    return gate.run(operation, async () => {
      await checkProgress(policy, policyRequired, { format: 'cot', phase, context, content: JSON.stringify(payload) });
      return gate.deliver(operation.request.conversationId, send);
    });
  }
  private async terminate(receipt: ProgressReceipt): Promise<void> {
    this.input.gate.resources.assertProgressReceipt(receipt);
    await checkProgress(this.input.policy, this.input.policyRequired, { format: 'cot', phase: 'complete',
      context: this.input.context, content: JSON.stringify({ reason: 'error' }) });
    await completeInterrupted(this.input.client, receipt);
    await this.finish(receipt);
  }
  private async finish(receipt: ProgressReceipt): Promise<void> {
    await this.input.gate.resources.finishProgress(receipt);
    this.refs.delete(receipt.messageId);
  }
}

/** Only terminal state is sent during host recovery. No old event payload is
 * persisted or replayed, and legacy unowned IDs never enter this path. */
export async function completeInterrupted(client: Pick<CotClient, 'complete'>, receipt: ProgressReceipt): Promise<void> {
  if (receipt.format !== 'cot' || !receipt.cotId) throw new Error('invalid CoT cleanup receipt');
  // Feishu rejects reason='interrupted' (HTTP 500/2200); 'error' is the
  // accepted terminal reason for a bubble closed during host recovery.
  try { await client.complete({ cotId: receipt.cotId, messageId: receipt.messageId }, 'error'); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('already in terminal status')) throw error;
  }
}
