import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../../platform/atomic-write';

type ReceiptMap = Record<string, { completedAt: number }>;

/** Durable completion receipts keyed by a digest of the transport msgid. */
export class FileWechatKfReceiptStore {
  private data: ReceiptMap = {};
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      this.data = normalizeReceiptMap(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  hasCompleted(receiptKey: string): boolean {
    assertReceiptKey(receiptKey);
    return Boolean(this.data[receiptKey]);
  }

  markCompleted(receiptKey: string, completedAt = Date.now()): void {
    assertReceiptKey(receiptKey);
    if (this.data[receiptKey]) return;
    this.data[receiptKey] = { completedAt };
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
        mode: 0o600,
      }));
  }
}

function normalizeReceiptMap(input: unknown): ReceiptMap {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: ReceiptMap = {};
  for (const [receiptKey, value] of Object.entries(input)) {
    if (!isReceiptKey(receiptKey) || !value || typeof value !== 'object') continue;
    const completedAt = (value as { completedAt?: unknown }).completedAt;
    if (typeof completedAt === 'number') result[receiptKey] = { completedAt };
  }
  return result;
}

function assertReceiptKey(receiptKey: string): void {
  if (!isReceiptKey(receiptKey)) throw new Error('invalid wxkf receipt key');
}

function isReceiptKey(receiptKey: string): boolean {
  return /^[0-9A-Za-z_-]{32,64}$/.test(receiptKey);
}
