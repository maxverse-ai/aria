import type { TriggerResultDeliveryRecord, TriggerResultDeliveryStore } from './types';

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
    this.records.set(record.deliveryId, clone(record));
    return clone(record);
  }

  async put(record: TriggerResultDeliveryRecord): Promise<TriggerResultDeliveryRecord> {
    this.records.set(record.deliveryId, clone(record));
    return clone(record);
  }
}

function clone<T>(value: T): T { return structuredClone(value) }
function cloneOptional<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : clone(value) }
