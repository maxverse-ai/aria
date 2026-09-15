import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { SpaceOperationGate, type SpaceOperation, type SpaceOperationCheckpoint } from './operation-gate';
import { immutable } from './immutable';
import { opaqueId, requiredId } from './identity';

interface RecordValue { checkpoint: SpaceOperationCheckpoint; fingerprint: string }
export function operationFingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k, canonical(v)]));
    return input;
  };
  return opaqueId('operation-payload', [canonical(value)]);
}
/** Sidecar to existing inbox/trigger/result ledgers, never another task queue. */
export class SpaceOperationLedger {
  private readonly records = new Map<string, RecordValue>();
  private saving: Promise<void> = Promise.resolve();
  constructor(readonly gate: SpaceOperationGate, private readonly file?: string) {}
  async load(): Promise<void> {
    if (!this.file) return;
    let raw: { schema?: string; records?: [string, RecordValue][] };
    try { raw = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (raw.schema !== 'aria.space.operation-ledger.v1' || !Array.isArray(raw.records)) throw new Error('invalid space operation ledger');
    const loaded = new Map<string, RecordValue>();
    for (const [key, record] of raw.records) {
      requiredId(key, 'operation key');
      if (loaded.has(key) || record.checkpoint?.schema !== 'aria.space.operation.v1' || !/^[a-f0-9]{64}$/.test(record.fingerprint)) throw new Error('invalid saved space operation');
      loaded.set(key, immutable(record));
    }
    for (const [key, value] of loaded) this.records.set(key, value);
  }
  has(key: string): boolean { return this.records.has(key); }
  async capture(key: string, operation: SpaceOperation, value: unknown): Promise<void> {
    requiredId(key, 'operation key');
    const fingerprint = operationFingerprint(value);
    const old = this.records.get(key);
    if (old) {
      if (old.fingerprint !== fingerprint || old.checkpoint.bindingRef !== operation.bindingRef
        || old.checkpoint.scopeRef !== operation.scopeRef || old.checkpoint.request.senderId !== operation.request.senderId) throw new Error('operation ownership cannot be replaced');
      await this.gate.restore(old.checkpoint);
      return;
    }
    const checkpoint = await this.gate.checkpoint(operation);
    // Check again after refreshing/retaining the grant: competing deliveries
    // must not replace the first owner while that asynchronous work is pending.
    const concurrent = this.records.get(key);
    if (concurrent) {
      if (concurrent.fingerprint !== fingerprint || concurrent.checkpoint.bindingRef !== operation.bindingRef
        || concurrent.checkpoint.scopeRef !== operation.scopeRef || concurrent.checkpoint.request.senderId !== operation.request.senderId) throw new Error('operation ownership cannot be replaced');
      await this.gate.restore(concurrent.checkpoint);
      return;
    }
    this.records.set(key, immutable({ checkpoint, fingerprint }));
    if (this.file) {
      const data = JSON.stringify({ schema: 'aria.space.operation-ledger.v1', records: [...this.records] });
      this.saving = this.saving.then(() => writeFileAtomic(this.file!, data + '\n', { mode: 0o600 }));
      await this.saving;
    }
  }
  async restore(key: string, value: unknown): Promise<SpaceOperation> {
    const record = this.records.get(key);
    if (!record || record.fingerprint !== operationFingerprint(value)) throw new Error('operation has no matching original space grant');
    return this.gate.restore(record.checkpoint);
  }
}
