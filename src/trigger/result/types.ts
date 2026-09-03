import type { ResultRoute } from '../../application/execution-intent';
import type { ChannelDeliveryReceipt, ChannelOutboundIntent } from '../../channel/plugin/types';
import type { TriggerDefinition, TriggerOccurrence } from '../state';
import type { TriggerExecutionResult } from '../runtime/types';

export type TriggerResultDeliveryState = 'pending' | 'retry-wait' | 'sent' | 'failed';

export interface TriggerResultDeliveryRecord {
  schemaVersion: 1;
  deliveryId: string;
  occurrenceId: string;
  routeId: string;
  state: TriggerResultDeliveryState;
  attempt: number;
  intent: ChannelOutboundIntent;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  errorCode?: string;
  receipt?: ChannelDeliveryReceipt;
}

export interface TriggerResultDeliveryStore {
  get(deliveryId: string): Promise<TriggerResultDeliveryRecord | undefined>;
  listReady(now: number): Promise<readonly TriggerResultDeliveryRecord[]>;
  create(record: TriggerResultDeliveryRecord): Promise<TriggerResultDeliveryRecord>;
  put(record: TriggerResultDeliveryRecord): Promise<TriggerResultDeliveryRecord>;
}

export interface ResolvedConversationRoute {
  profileId: string;
  pluginId: string;
  instanceId: string;
  scopeId: string;
  sourceMessageId?: string;
}

/** Resolves an opaque anchor outside durable schedule records. */
export interface TriggerConversationRouteResolver {
  resolve(profileId: string, conversationRef: string): Promise<ResolvedConversationRoute>;
}

export interface TriggerResultChannel {
  deliver(intent: ChannelOutboundIntent): Promise<ChannelDeliveryReceipt>;
}

export interface TriggerResultGateway {
  route(definition: TriggerDefinition, occurrence: TriggerOccurrence, result: TriggerExecutionResult): Promise<void>;
  reconcile(): Promise<void>;
}

export interface TriggerResultRouteInput {
  definition: TriggerDefinition;
  occurrence: TriggerOccurrence;
  result: TriggerExecutionResult;
  route: ResultRoute;
}
