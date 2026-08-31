import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write';
import type { WechatKfMessage } from './types';

/** Durable accepted-message queue. Filenames never expose the transport msgid. */
export class FileWechatKfMessageInbox {
  constructor(private readonly directory: string) {
    if (!directory) throw new Error('wxkf message inbox directory is required');
  }

  async enqueue(message: WechatKfMessage): Promise<void> {
    assertMessageId(message.msgid);
    await writeFileAtomic(this.pathFor(message.msgid), `${JSON.stringify(message)}\n`, {
      mode: 0o600,
    });
  }

  async list(): Promise<WechatKfMessage[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const messages: WechatKfMessage[] = [];
    for (const name of names.filter((value) => value.endsWith('.json')).sort()) {
      const raw = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as unknown;
      const message = normalizeMessage(raw);
      if (!message) throw new Error('invalid persisted wxkf message');
      messages.push(message);
    }
    return messages.sort((left, right) => left.send_time - right.send_time || left.msgid.localeCompare(right.msgid));
  }

  async remove(messageId: string): Promise<void> {
    assertMessageId(messageId);
    await rm(this.pathFor(messageId), { force: true });
  }

  private pathFor(messageId: string): string {
    const digest = createHash('sha256')
      .update(`wxkf-message-inbox:v1:${messageId}`)
      .digest('base64url');
    return join(this.directory, `${digest}.json`);
  }
}

function normalizeMessage(input: unknown): WechatKfMessage | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<WechatKfMessage>;
  if (
    typeof raw.msgid !== 'string' || !raw.msgid ||
    typeof raw.send_time !== 'number' ||
    typeof raw.origin !== 'number' ||
    typeof raw.msgtype !== 'string'
  ) {
    return undefined;
  }
  return raw as WechatKfMessage;
}

function assertMessageId(messageId: string): void {
  if (!messageId) throw new Error('wxkf message id is required');
}
