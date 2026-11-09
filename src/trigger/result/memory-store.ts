import type { TriggerResultDeliveryRecord, TriggerResultDeliveryStore } from './types';
import { normalizeDeliveryRecord } from './types';

export class InMemoryTriggerResultDeliveryStore implements TriggerResultDeliveryStore {
  private readonly records = new Map<string, TriggerResultDeliveryRecord>();

  async get(deliveryId: string): Promise<TriggerResultDeliveryRecord | undefined> {
    return cloneOptional(this.records.get(deliveryId));
  }

  async listReady(now: number): Promise<readonly TriggerResultDeliveryRecord[]> {
    return [...this.records.values()]
      .filter((item) => item.state === 'pending' || (item.state === 'retry-wait' && item.nextAttemptAt! <= now))
      .sort((a, b) => a.createdAt - b.createdAt || a.deliveryId.localeCompare(b.deliveryId))
      .map(clone);
  }

  async create(record: TriggerResultDeliveryRecord): Promise<TriggerResultDeliveryRecord> {
    const existing = this.records.get(record.deliveryId);
    if (existing) return clone(existing);
    this.records.set(record.deliveryId, clone(normalizeDeliveryRecord(record)));
    return clone(normalizeDeliveryRecord(record));
  }

  async put(record: TriggerResultDeliveryRecord): Promise<TriggerResultDeliveryRecord> {
    if (this.records.get(record.deliveryId)?.claimToken) throw new Error('claimed delivery requires fenced settlement');
    this.records.set(record.deliveryId, clone(normalizeDeliveryRecord(record)));
    return clone(normalizeDeliveryRecord(record));
  }

  async claim(deliveryId: string, token: string, now: number): Promise<TriggerResultDeliveryRecord | undefined> {
    if (!token) throw new TypeError('delivery claim token is required');
    const record = this.records.get(deliveryId);
    if (!record || !(record.state === 'pending' || (record.state === 'retry-wait' && record.nextAttemptAt! <= now))) return undefined;
    const claimed: TriggerResultDeliveryRecord = {
      ...record, state: 'delivering', claimToken: token, attempt: record.attempt + 1,
      updatedAt: now, nextAttemptAt: undefined,
    };
    this.records.set(deliveryId, claimed);
    return clone(claimed);
  }

  async settle(record: TriggerResultDeliveryRecord, token: string): Promise<boolean> {
    const current = this.records.get(record.deliveryId);
    if (!current || current.claimToken !== token || !['delivering', 'uncertain'].includes(current.state)) return false;
    this.records.set(record.deliveryId, clone({ ...record, claimToken: token }));
    return true;
  }

  async listUncertain(): Promise<readonly TriggerResultDeliveryRecord[]> {
    return [...this.records.values()]
      .filter(record => record.state === 'delivering' || record.state === 'uncertain').map(clone);
  }
}

function clone<T>(value: T): T { return structuredClone(value) }
function cloneOptional<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : clone(value) }
