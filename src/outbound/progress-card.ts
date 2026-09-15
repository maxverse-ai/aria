import type { LarkChannel, SendOptions } from '@larksuite/channel';
import type { SpaceOperation, SpaceOperationGate } from '../space/operation-gate';
import type { ProgressReceipt } from '../space/resources';
import type { OutboundPolicyContext } from './plugin';
import { checkProgress, type ProgressPolicy } from './progress-policy';

/** Owns a run's snapshots and timers. Only the latest pending snapshot is kept;
 * every actual request still traverses the original authorization and policy. */
export class ProgressCard {
  private cardId?: string;
  private receipt?: ProgressReceipt;
  private done = false;
  private pending?: object;
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private failure?: unknown;
  constructor(private readonly input: {
    channel: LarkChannel; gate: SpaceOperationGate; operation: SpaceOperation;
    context: OutboundPolicyContext; policy?: ProgressPolicy; policyRequired: boolean;
    sendOptions: SendOptions;
    terminate(receipt: ProgressReceipt): Promise<void>;
  }) {}
  opened(): boolean { return Boolean(this.receipt || this.pending || this.flushing); }
  queue(card: object): void {
    if (this.done) throw new Error('progress card is complete');
    if (this.failure) throw this.failure;
    this.pending = card;
    this.schedule();
  }
  private schedule(): void {
    if (this.done || this.timer || this.flushing || !this.pending || this.failure) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 500);
  }
  private async flush(): Promise<void> {
    if (this.flushing) await this.flushing;
    if (this.done || this.failure || !this.pending) return;
    const card = this.pending; this.pending = undefined;
    this.flushing = this.update(card).catch(error => { this.failure = error; this.pending = undefined; })
      .finally(() => { this.flushing = undefined; this.schedule(); });
    await this.flushing;
  }
  async update(card: object): Promise<void> {
    if (this.done) throw new Error('progress card is complete');
    const { gate, operation, channel } = this.input;
    if (this.input.sendOptions.replyTo !== this.input.context.sourceMessageId) throw new Error('foreign progress origin');
    const owner = gate.resources.captureProgressOwner(operation.context);
    await gate.run(operation, async () => {
      await checkProgress(this.input.policy, this.input.policyRequired, {
        format: 'card', phase: this.cardId ? 'update' : 'create', context: this.input.context, content: JSON.stringify(card),
      });
      if (this.done) throw new Error('progress card is complete');
      if (!this.cardId) {
        this.cardId = (await channel.createCard(card)).cardId;
        // A card is not visible until send. Recheck after create, before send.
        await gate.refresh(operation);
        if (this.done) throw new Error('progress card is complete');
        const message = await channel.send(operation.request.conversationId, { cardId: this.cardId }, this.input.sendOptions);
        this.receipt = await gate.resources.recordProgress(owner,
          { format: 'card', cardId: this.cardId, messageId: message.messageId });
      } else {
        if (!this.receipt) throw new Error('progress card lacks a message receipt');
        gate.resources.assertProgress(operation.context, this.receipt);
        const sequence = await gate.resources.nextProgressSequence(this.receipt);
        await channel.updateCardById(this.cardId, card, sequence);
      }
    });
  }
  async finish(): Promise<{ messageId: string; cardId: string } | undefined> {
    if (this.done) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.failure) throw this.failure;
    this.done = true;
    if (this.receipt) {
      const result = { messageId: this.receipt.messageId, cardId: this.receipt.cardId! };
      await this.input.gate.refresh(this.input.operation);
      await this.input.gate.resources.finishProgress(this.receipt);
      this.receipt = undefined;
      return result;
    }
  }
  async close(): Promise<void> {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.pending = undefined;
    await this.flushing;
    if (!this.receipt) return;
    await this.input.terminate(this.receipt);
    await this.input.gate.resources.finishProgress(this.receipt);
    this.receipt = undefined;
  }
}
