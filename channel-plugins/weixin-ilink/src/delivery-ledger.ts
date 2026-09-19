import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChannelDeliveryReceipt } from '@maxverse-ai/aria';

/**
 * Package-owned delivery ledger keyed by the checkpointed `deliveryId`.
 *
 * iLink `sendmessage` carries no provider idempotency key, so the runtime
 * must dedupe coordinator retries itself: a recorded receipt is returned
 * without re-sending. A crash between provider acceptance and the ledger
 * write can still double-send — that window is documented in
 * docs/WEIXIN_ILINK_PROTOCOL.md and cannot be closed client-side.
 */
export interface IlinkDeliveryLedger {
  get(deliveryId: string): Promise<ChannelDeliveryReceipt | undefined>;
  record(deliveryId: string, receipt: ChannelDeliveryReceipt): Promise<void>;
}

/** Volatile ledger for tests and undecorated composition. */
export class InMemoryDeliveryLedger implements IlinkDeliveryLedger {
  private readonly receipts = new Map<string, ChannelDeliveryReceipt>();

  async get(deliveryId: string): Promise<ChannelDeliveryReceipt | undefined> {
    return this.receipts.get(deliveryId);
  }

  async record(deliveryId: string, receipt: ChannelDeliveryReceipt): Promise<void> {
    this.receipts.set(deliveryId, receipt);
  }
}

function isReceipt(value: unknown): value is ChannelDeliveryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.deliveryId === 'string' &&
    (record.status === 'accepted' || record.status === 'sent')
  );
}

/**
 * One JSON file per deliveryId under a deliveries directory, written
 * through a same-directory rename. Filename-safe encoding keeps any
 * coordinator-chosen id inside the directory.
 */
export class FileIlinkDeliveryLedger implements IlinkDeliveryLedger {
  constructor(private readonly dir: string) {}

  async get(deliveryId: string): Promise<ChannelDeliveryReceipt | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(deliveryId), 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isReceipt(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async record(deliveryId: string, receipt: ChannelDeliveryReceipt): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temp = join(this.dir, `.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(temp, JSON.stringify(receipt), { mode: 0o600 });
    await rename(temp, this.pathFor(deliveryId));
  }

  /** Test/diagnostics helper: count of recorded receipts on disk. */
  async size(): Promise<number> {
    try {
      return (await readdir(this.dir)).filter((name) => name.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  private pathFor(deliveryId: string): string {
    return join(this.dir, `${encodeURIComponent(deliveryId)}.json`);
  }
}
