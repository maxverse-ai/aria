import { CHANNEL_PLUGIN_ABI_VERSION, type ChannelOutboundIntent } from '../../channel/plugin/types';
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

  private async deliver(record: TriggerResultDeliveryRecord): Promise<void> {
    const existing = await this.options.store.get(record.deliveryId);
    if (!existing || existing.state === 'sent' || existing.state === 'failed') return;
    const attempt = existing.attempt + 1;
    try {
      const receipt = await this.options.channel.deliver(existing.intent);
      await this.options.store.put({
        ...existing, state: 'sent', attempt, receipt, errorCode: undefined,
        nextAttemptAt: undefined, updatedAt: this.now(),
      });
    } catch (error) {
      const exhausted = attempt >= this.maxAttempts;
      await this.options.store.put({
        ...existing,
        state: exhausted ? 'failed' : 'retry-wait',
        attempt,
        errorCode: stableCode(error),
        nextAttemptAt: exhausted ? undefined : this.now() + this.retryDelayMs,
        updatedAt: this.now(),
      });
    }
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
