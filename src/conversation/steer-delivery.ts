import type { AgentSteeringInsertion } from '../agent/steering';

export interface SteerDeliveryRecord {
  requestId: string;
  insertion: AgentSteeringInsertion | 'failed';
}

export type SteerDeliveryDisposition<T> =
  | { kind: 'delivered'; insertion: AgentSteeringInsertion; value: T }
  | { kind: 'requeue'; value: T }
  | { kind: 'unknown' };

/**
 * Retains an accepted-but-unconfirmed steer payload until the engine's
 * delivery evidence arrives. A `failed` record returns the payload for
 * requeueing — the transport later reported it never reached the engine,
 * so the input must not count as delivered. Terminal classifications
 * remove the entry exactly once.
 */
export class SteerDeliveryTracker<T> {
  private readonly inflight = new Map<string, T>();

  remember(requestId: string, value: T): void {
    this.inflight.set(requestId, value);
  }

  handle(record: SteerDeliveryRecord): SteerDeliveryDisposition<T> {
    const value = this.inflight.get(record.requestId);
    if (value === undefined) return { kind: 'unknown' };
    this.inflight.delete(record.requestId);
    if (record.insertion === 'failed') return { kind: 'requeue', value };
    return { kind: 'delivered', insertion: record.insertion, value };
  }

  get size(): number {
    return this.inflight.size;
  }
}
