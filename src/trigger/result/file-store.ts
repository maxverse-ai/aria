import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../../platform/atomic-write';
import type { TriggerResultDeliveryRecord, TriggerResultDeliveryStore } from './types';
import { normalizeDeliveryRecord } from './types';

interface FileState {
  schema: 'aria.trigger-result-deliveries.v1';
  version: 1;
  records: Record<string, TriggerResultDeliveryRecord>;
}

const EMPTY: FileState = { schema: 'aria.trigger-result-deliveries.v1', version: 1, records: {} };

export class FileTriggerResultDeliveryStore implements TriggerResultDeliveryStore {
  constructor(private readonly path: string) {
    if (!path) throw new TypeError('trigger result delivery path is required');
  }

  async get(deliveryId: string): Promise<TriggerResultDeliveryRecord | undefined> {
    return cloneOptional((await this.read()).records[deliveryId]);
  }

  async listReady(now: number): Promise<readonly TriggerResultDeliveryRecord[]> {
    return Object.values((await this.read()).records)
      .filter((item) => item.state === 'pending' || (item.state === 'retry-wait' && item.nextAttemptAt! <= now))
      .sort((a, b) => a.createdAt - b.createdAt || a.deliveryId.localeCompare(b.deliveryId)).map(clone);
  }

  async create(record: TriggerResultDeliveryRecord): Promise<TriggerResultDeliveryRecord> {
    return this.mutate((state) => {
      const existing = state.records[record.deliveryId];
      if (existing) return clone(existing);
      state.records[record.deliveryId] = clone(record);
      return clone(record);
    });
  }

  async put(record: TriggerResultDeliveryRecord): Promise<TriggerResultDeliveryRecord> {
    return this.mutate((state) => {
      if (state.records[record.deliveryId]?.claimToken) throw new Error('claimed delivery requires fenced settlement');
      state.records[record.deliveryId] = clone(record);
      return clone(record);
    });
  }

  async claim(deliveryId: string, token: string, now: number): Promise<TriggerResultDeliveryRecord | undefined> {
    if (!token) throw new TypeError('delivery claim token is required');
    return this.mutate((state) => {
      const record = state.records[deliveryId];
      if (!record || !(record.state === 'pending' || (record.state === 'retry-wait' && record.nextAttemptAt! <= now))) return undefined;
      const claimed: TriggerResultDeliveryRecord = {
        ...record, state: 'delivering', claimToken: token, attempt: record.attempt + 1,
        updatedAt: now, nextAttemptAt: undefined,
      };
      state.records[deliveryId] = claimed;
      return claimed;
    });
  }

  async settle(record: TriggerResultDeliveryRecord, token: string): Promise<boolean> {
    return this.mutate((state) => {
      const current = state.records[record.deliveryId];
      if (!current || current.claimToken !== token || !['delivering', 'uncertain'].includes(current.state)) return false;
      state.records[record.deliveryId] = clone({ ...record, claimToken: token });
      return true;
    });
  }

  async listUncertain(): Promise<readonly TriggerResultDeliveryRecord[]> {
    return Object.values((await this.read()).records)
      .filter(record => record.state === 'delivering' || record.state === 'uncertain').map(clone);
  }

  private async read(): Promise<FileState> {
    await this.ensure();
    const state = JSON.parse(await readFile(this.path, 'utf8')) as FileState;
    if (state.schema !== EMPTY.schema || state.version !== 1 || !state.records) throw new Error('invalid trigger result delivery file');
    for (const [id, record] of Object.entries(state.records)) state.records[id] = normalizeDeliveryRecord(record);
    return state;
  }

  private async mutate<T>(update: (state: FileState) => T): Promise<T> {
    await this.ensure();
    const release = await lockfile.lock(this.path, { realpath: false, retries: { retries: 40, minTimeout: 5, maxTimeout: 100 } });
    try {
      const state = await this.read();
      const result = update(state);
      await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return clone(result);
    } finally { await release() }
  }

  private async ensure(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try { await writeFile(this.path, `${JSON.stringify(EMPTY, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await chmod(this.path, 0o600).catch(() => undefined);
  }
}

function clone<T>(value: T): T { return structuredClone(value) }
function cloneOptional<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : clone(value) }
