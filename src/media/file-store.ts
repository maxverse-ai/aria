import { createHash } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import {
  normalizeAttachments,
  safeExtensionForMime,
  type AttachmentKind,
  type AttachmentPolicyOptions,
  type NormalizedAttachment,
} from './attachment';

export interface FileAttachmentInput {
  content: Uint8Array;
  kind: AttachmentKind;
  mime: string;
  source: string;
  sourceMessageId: string;
  sourceFileKey: string;
  originalName?: string;
}

/** Content-addressed, atomic storage for channel-provided attachment bytes. */
export class FileAttachmentStore {
  constructor(private readonly rootDirectory: string) {
    if (!rootDirectory) throw new Error('attachment store root directory is required');
  }

  async persist(
    input: FileAttachmentInput,
    options: Partial<AttachmentPolicyOptions> = {},
  ): Promise<NormalizedAttachment> {
    if (!(input.content instanceof Uint8Array) || input.content.byteLength === 0) {
      throw new Error('attachment content must be non-empty bytes');
    }
    for (const [name, value] of Object.entries({
      source: input.source,
      sourceMessageId: input.sourceMessageId,
      sourceFileKey: input.sourceFileKey,
      mime: input.mime,
    })) {
      if (!value || /[\0\r\n]/.test(value)) throw new Error(`attachment ${name} is invalid`);
    }
    const hash = createHash('sha256').update(input.content).digest('hex');
    const absPath = join(this.rootDirectory, `${hash}.${safeExtensionForMime(input.mime)}`);
    const [attachment] = normalizeAttachments([{
      absPath,
      kind: input.kind,
      size: input.content.byteLength,
      mime: input.mime,
      hash,
      source: input.source,
      sourceMessageId: input.sourceMessageId,
      sourceFileKey: input.sourceFileKey,
      ...(input.originalName ? { originalName: input.originalName } : {}),
    }], options);
    if (!attachment) throw new Error('attachment normalization returned no result');
    if (attachment.decision !== 'accepted') return attachment;
    try {
      const existing = await stat(absPath);
      if (!existing.isFile() || existing.size !== input.content.byteLength) {
        throw new Error('attachment content-addressed path is inconsistent');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFileAtomic(absPath, Buffer.from(input.content), { mode: 0o600 });
    }
    return attachment;
  }

  async remove(attachment: Pick<NormalizedAttachment, 'absPath'>): Promise<void> {
    const root = resolve(this.rootDirectory);
    const target = resolve(attachment.absPath);
    if (dirname(target) !== root) throw new Error('attachment path is outside the store');
    await rm(target, { force: true });
  }
}
