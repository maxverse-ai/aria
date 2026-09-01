import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write';

export interface WechatKfTextDeliveryChunk {
  kind: 'text';
  content: string;
  messageId: string;
  deliveredAt?: number;
}

export interface WechatKfImageDeliveryChunk {
  kind: 'image';
  assetRef: string;
  mediaId?: string;
  mediaExpiresAt?: number;
  messageId: string;
  deliveredAt?: number;
}

export type WechatKfDeliveryChunk = WechatKfTextDeliveryChunk | WechatKfImageDeliveryChunk;

export type WechatKfDeliveryChunkInput =
  | Omit<WechatKfTextDeliveryChunk, 'deliveredAt'>
  | Omit<WechatKfImageDeliveryChunk, 'deliveredAt'>
  /** Backward-compatible input for existing text-only callers. */
  | { content: string; messageId: string };

export interface WechatKfPreparedDelivery {
  schemaVersion: 2;
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
    chunks: ReadonlyArray<WechatKfDeliveryChunkInput>,
    createdAt = Date.now(),
  ): Promise<WechatKfPreparedDelivery> {
    assertSourceMessageId(sourceMessageId);
    const existing = await this.get(sourceMessageId);
    if (existing) return existing;
    const delivery = normalizePreparedDelivery({
      schemaVersion: 2,
      createdAt,
      chunks: chunks.map((chunk) => (
        'kind' in chunk ? { ...chunk } : { kind: 'text', ...chunk }
      )),
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

  async markImageMaterialized(
    sourceMessageId: string,
    part: number,
    materialized: Readonly<{ mediaId: string; expiresAt?: number }>,
  ): Promise<void> {
    const delivery = await this.get(sourceMessageId);
    if (!delivery) throw new Error('wxkf prepared delivery is missing');
    if (!Number.isInteger(part) || part < 0 || part >= delivery.chunks.length) {
      throw new Error('invalid wxkf delivery part');
    }
    const chunk = delivery.chunks[part];
    if (!chunk || chunk.kind !== 'image') throw new Error('wxkf delivery part is not an image');
    if (!isMediaId(materialized.mediaId)
      || (materialized.expiresAt !== undefined
        && (!Number.isFinite(materialized.expiresAt) || materialized.expiresAt < 0))) {
      throw new Error('invalid wxkf image materialization');
    }
    delivery.chunks[part] = {
      ...chunk,
      mediaId: materialized.mediaId,
      ...(materialized.expiresAt === undefined ? {} : { mediaExpiresAt: materialized.expiresAt }),
    };
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
  const raw = input as {
    schemaVersion?: unknown;
    createdAt?: unknown;
    chunks?: unknown;
  };
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2)
    || typeof raw.createdAt !== 'number'
    || !Array.isArray(raw.chunks)) {
    return undefined;
  }
  const chunks: WechatKfDeliveryChunk[] = [];
  for (const chunk of raw.chunks) {
    if (!chunk || typeof chunk !== 'object') return undefined;
    const value = chunk as Record<string, unknown>;
    if (typeof value.messageId !== 'string'
      || !/^[0-9A-Za-z_-]{1,32}$/.test(value.messageId)
      || (value.deliveredAt !== undefined && typeof value.deliveredAt !== 'number')) {
      return undefined;
    }
    const delivered = value.deliveredAt === undefined ? {} : { deliveredAt: value.deliveredAt };
    const kind = raw.schemaVersion === 1 ? 'text' : value.kind;
    if (kind === 'text' && typeof value.content === 'string') {
      chunks.push({ kind, content: value.content, messageId: value.messageId, ...delivered });
    } else if (
      kind === 'image'
      && typeof value.assetRef === 'string'
      && isAssetRef(value.assetRef)
      && (value.mediaId === undefined || (typeof value.mediaId === 'string' && isMediaId(value.mediaId)))
      && (value.mediaExpiresAt === undefined
        || (typeof value.mediaExpiresAt === 'number' && Number.isFinite(value.mediaExpiresAt)))
    ) {
      chunks.push({
        kind,
        assetRef: value.assetRef,
        ...(value.mediaId === undefined ? {} : { mediaId: value.mediaId }),
        ...(value.mediaExpiresAt === undefined ? {} : { mediaExpiresAt: value.mediaExpiresAt }),
        messageId: value.messageId,
        ...delivered,
      });
    } else {
      return undefined;
    }
  }
  if (chunks.length === 0) return undefined;
  return { schemaVersion: 2, createdAt: raw.createdAt, chunks };
}

function isAssetRef(value: string): boolean {
  return /^[^\0\r\n]{1,1024}$/.test(value);
}

function isMediaId(value: string): boolean {
  return /^[^\0\r\n]{1,512}$/.test(value);
}

function assertSourceMessageId(sourceMessageId: string): void {
  if (!sourceMessageId) throw new Error('wxkf source message id is required');
}
