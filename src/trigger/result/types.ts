import type { ResultRoute } from '../../application/execution-intent';
import type { ChannelDeliveryReceipt, ChannelOutboundIntent } from '../../channel/plugin/types';
import type { TriggerDefinition, TriggerOccurrence } from '../state';
import type { TriggerExecutionResult } from '../runtime/types';

export type TriggerResultDeliveryState = 'pending' | 'retry-wait' | 'delivering' | 'uncertain' | 'sent' | 'failed';

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
  /** Durable ownership token. Never reclaimed by a timeout or restart. */
  claimToken?: string;
  resolutionReason?: string;
  /** Distinguishes safe retries from legacy records that retried any error. */
  confirmedNotAccepted?: true;
}

export function normalizeDeliveryRecord(record: TriggerResultDeliveryRecord): TriggerResultDeliveryRecord {
  return record.state === 'retry-wait' && record.confirmedNotAccepted !== true
    ? { ...record, state: 'uncertain', nextAttemptAt: undefined, errorCode: 'legacy-result-outcome-unknown',
      claimToken: record.claimToken ?? `legacy:${record.deliveryId}:${record.attempt}:${record.updatedAt}` }
    : record;
}

export interface TriggerResultDeliveryStore {
  get(deliveryId: string): Promise<TriggerResultDeliveryRecord | undefined>;
  listReady(now: number): Promise<readonly TriggerResultDeliveryRecord[]>;
  create(record: TriggerResultDeliveryRecord): Promise<TriggerResultDeliveryRecord>;
  put(record: TriggerResultDeliveryRecord): Promise<TriggerResultDeliveryRecord>;
  claim(deliveryId: string, token: string, now: number): Promise<TriggerResultDeliveryRecord | undefined>;
  settle(record: TriggerResultDeliveryRecord, token: string): Promise<boolean>;
  listUncertain(): Promise<readonly TriggerResultDeliveryRecord[]>;
}

/** Only use when the channel can prove this attempt was never accepted. */
export class TriggerResultRejectedError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = 'TriggerResultRejectedError';
  }
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
