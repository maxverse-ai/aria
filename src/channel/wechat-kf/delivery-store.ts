import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write';

export interface WechatKfDeliveryChunk {
  content: string;
  messageId: string;
  deliveredAt?: number;
}

export interface WechatKfPreparedDelivery {
  schemaVersion: 1;
  createdAt: number;
  chunks: WechatKfDeliveryChunk[];
}

/** Durable answer checkpoint. Transport retries resume here without rerunning the agent. */
export class FileWechatKfDeliveryStore {
  constructor(private readonly directory: string) {
    if (!directory) throw new Error('wxkf delivery directory is required');
  }

  async get(sourceMessageId: string): Promise<WechatKfPreparedDelivery | undefined> {
    assertSourceMessageId(sourceMessageId);
    try {
      const raw = JSON.parse(await readFile(this.pathFor(sourceMessageId), 'utf8')) as unknown;
      const delivery = normalizePreparedDelivery(raw);
      if (!delivery) throw new Error('invalid persisted wxkf delivery');
      return delivery;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async create(
    sourceMessageId: string,
    chunks: ReadonlyArray<Pick<WechatKfDeliveryChunk, 'content' | 'messageId'>>,
    createdAt = Date.now(),
  ): Promise<WechatKfPreparedDelivery> {
    assertSourceMessageId(sourceMessageId);
    const existing = await this.get(sourceMessageId);
    if (existing) return existing;
    const delivery = normalizePreparedDelivery({
      schemaVersion: 1,
      createdAt,
      chunks: chunks.map((chunk) => ({ ...chunk })),
    });
    if (!delivery) throw new Error('invalid wxkf prepared delivery');
    await this.persist(sourceMessageId, delivery);
    return delivery;
  }

  async markDelivered(sourceMessageId: string, part: number, deliveredAt = Date.now()): Promise<void> {
    const delivery = await this.get(sourceMessageId);
    if (!delivery) throw new Error('wxkf prepared delivery is missing');
    if (!Number.isInteger(part) || part < 0 || part >= delivery.chunks.length) {
      throw new Error('invalid wxkf delivery part');
    }
    if (delivery.chunks[part]?.deliveredAt !== undefined) return;
    delivery.chunks[part] = { ...delivery.chunks[part]!, deliveredAt };
    await this.persist(sourceMessageId, delivery);
  }

  async remove(sourceMessageId: string): Promise<void> {
    assertSourceMessageId(sourceMessageId);
    await rm(this.pathFor(sourceMessageId), { force: true });
  }

  private async persist(sourceMessageId: string, delivery: WechatKfPreparedDelivery): Promise<void> {
    await writeFileAtomic(this.pathFor(sourceMessageId), `${JSON.stringify(delivery, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  private pathFor(sourceMessageId: string): string {
    const digest = createHash('sha256')
      .update(`wxkf-delivery:v1:${sourceMessageId}`)
      .digest('base64url');
    return join(this.directory, `${digest}.json`);
  }
}

function normalizePreparedDelivery(input: unknown): WechatKfPreparedDelivery | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as Partial<WechatKfPreparedDelivery>;
  if (raw.schemaVersion !== 1 || typeof raw.createdAt !== 'number' || !Array.isArray(raw.chunks)) {
    return undefined;
  }
  const chunks: WechatKfDeliveryChunk[] = [];
  for (const chunk of raw.chunks) {
    if (!chunk || typeof chunk !== 'object') return undefined;
    const value = chunk as Partial<WechatKfDeliveryChunk>;
    if (
      typeof value.content !== 'string' ||
      typeof value.messageId !== 'string' ||
      !/^[0-9A-Za-z_-]{1,32}$/.test(value.messageId) ||
      (value.deliveredAt !== undefined && typeof value.deliveredAt !== 'number')
    ) {
      return undefined;
    }
    chunks.push({
      content: value.content,
      messageId: value.messageId,
      ...(value.deliveredAt === undefined ? {} : { deliveredAt: value.deliveredAt }),
    });
  }
  if (chunks.length === 0) return undefined;
  return { schemaVersion: 1, createdAt: raw.createdAt, chunks };
}

function assertSourceMessageId(sourceMessageId: string): void {
  if (!sourceMessageId) throw new Error('wxkf source message id is required');
}
