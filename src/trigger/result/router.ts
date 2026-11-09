import { CHANNEL_PLUGIN_ABI_VERSION, type ChannelOutboundIntent } from '../../channel/plugin/types';
import type { ChannelDeliveryReceipt } from '../../channel/plugin/types';
import { randomUUID } from 'node:crypto';
import { TriggerResultRejectedError } from './types';
import type { ResultRoute } from '../../application/execution-intent';
import type { TriggerDefinition, TriggerOccurrence } from '../state';
import type { TriggerExecutionResult } from '../runtime/types';
import type {
  TriggerConversationRouteResolver,
  TriggerResultChannel,
  TriggerResultDeliveryRecord,
  TriggerResultDeliveryStore,
  TriggerResultGateway,
} from './types';

export interface TriggerResultRouterOptions {
  beforeCheckpoint?: (definition: TriggerDefinition, intent: ChannelOutboundIntent) => Promise<void>;
  store: TriggerResultDeliveryStore;
  resolver: TriggerConversationRouteResolver;
  channel: TriggerResultChannel;
  now?: () => number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export class TriggerResultRouter implements TriggerResultGateway {
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: TriggerResultRouterOptions) {
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
  }

  async route(definition: TriggerDefinition, occurrence: TriggerOccurrence, result: TriggerExecutionResult): Promise<void> {
    if (!result.output?.text) return;
    if (definition.revision !== occurrence.definitionRevision) throw new Error('trigger result definition changed');
    for (const route of flatten(definition.intentTemplate.resultRoutes)) {
      if (route.kind !== 'conversation') continue;
      const target = await this.options.resolver.resolve(definition.profileId, route.conversationRef);
      const deliveryId = triggerResultDeliveryId(occurrence.id, route.routeId);
      const intent: ChannelOutboundIntent = {
        abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
        ...target,
        deliveryId,
        content: { kind: 'text', text: result.output.text },
      };
      await this.options.beforeCheckpoint?.(definition, intent);
      await this.options.store.create({
        schemaVersion: 1, deliveryId, occurrenceId: occurrence.id, routeId: route.routeId,
        state: 'pending', attempt: 0, intent, createdAt: this.now(), updatedAt: this.now(),
      });
    }
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    for (const record of await this.options.store.listReady(this.now())) await this.deliver(record);
  }

  async inspectUncertain(): Promise<readonly TriggerResultDeliveryRecord[]> {
    return this.options.store.listUncertain();
  }

  /** Operator reconciliation never sends. Quiesce the original owner first. */
  async resolveUncertain(deliveryId: string, token: string,
    resolution: { reason: string; receipt: ChannelDeliveryReceipt }
      | { reason: string; abandon: true }
      | { reason: string; retry: true; ownerStopped: true; confirmedNotAccepted: true },
  ): Promise<boolean> {
    if (!resolution.reason.trim()) throw new TypeError('delivery resolution reason is required');
    if ('retry' in resolution && (resolution.ownerStopped !== true || resolution.confirmedNotAccepted !== true)) {
      throw new Error('retry requires stopped ownership and confirmed nonacceptance');
    }
    const current = await this.options.store.get(deliveryId);
    if (!current || !['delivering', 'uncertain'].includes(current.state) || current.claimToken !== token) return false;
    if ('receipt' in resolution && resolution.receipt.deliveryId !== deliveryId) throw new Error('delivery receipt ID mismatch');
    return this.options.store.settle({
      ...current, state: 'receipt' in resolution ? 'sent' : 'retry' in resolution ? 'retry-wait' : 'failed',
      receipt: 'receipt' in resolution ? resolution.receipt : undefined,
      resolutionReason: resolution.reason, updatedAt: this.now(), errorCode: undefined,
      nextAttemptAt: 'retry' in resolution ? this.now() : undefined,
      confirmedNotAccepted: 'retry' in resolution ? true : undefined,
    }, token);
  }

  private async deliver(record: TriggerResultDeliveryRecord): Promise<void> {
    const token = randomUUID();
    const existing = await this.options.store.claim(record.deliveryId, token, this.now());
    if (!existing) return;
    let receipt: ChannelDeliveryReceipt;
    try {
      receipt = await this.options.channel.deliver(existing.intent);
    } catch (error) {
      const rejected = error instanceof TriggerResultRejectedError;
      const exhausted = existing.attempt >= this.maxAttempts;
      await this.options.store.settle({
        ...existing,
        state: rejected ? (exhausted ? 'failed' : 'retry-wait') : 'uncertain',
        errorCode: stableCode(error),
        nextAttemptAt: rejected && !exhausted ? this.now() + this.retryDelayMs : undefined,
        confirmedNotAccepted: rejected ? true : undefined,
        updatedAt: this.now(),
      }, token);
      return;
    }
    // A checkpoint failure is not a provider rejection. Keep the persisted
    // delivering claim; never turn success + failed persistence into a retry.
    if (receipt.deliveryId !== existing.deliveryId) throw new Error('delivery receipt ID mismatch');
    await this.options.store.settle({
      ...existing, state: 'sent', receipt, errorCode: undefined,
      nextAttemptAt: undefined, updatedAt: this.now(),
    }, token);
  }
}

export function triggerResultDeliveryId(occurrenceId: string, routeId: string): string {
  return `${occurrenceId}:${routeId}`;
}

function flatten(routes: readonly ResultRoute[]): ResultRoute[] {
  return routes.flatMap((route) => route.kind === 'multi' ? route.routes : [route]);
}

function stableCode(error: unknown): string {
  const raw = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'channel-delivery-failed';
  const code = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 128);
  return /^[a-z]/.test(code) ? code : 'channel-delivery-failed';
}
