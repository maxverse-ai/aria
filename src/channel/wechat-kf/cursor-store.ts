import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write';

export interface WechatKfCursorStore {
  get(openKfid: string): Promise<string | undefined>;
  set(openKfid: string, cursor: string): Promise<void>;
}

export interface FileWechatKfCursorStoreOptions {
  directory: string;
}

export class FileWechatKfCursorStore implements WechatKfCursorStore {
  private readonly directory: string;

  constructor(options: FileWechatKfCursorStoreOptions) {
    if (!options.directory) throw new Error('wechat-kf cursor directory is required');
    this.directory = options.directory;
  }

  async get(openKfid: string): Promise<string | undefined> {
    const path = this.pathFor(openKfid);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { openKfid?: unknown }).openKfid !== openKfid ||
      typeof (parsed as { cursor?: unknown }).cursor !== 'string'
    ) {
      throw new Error('invalid wechat-kf cursor file');
    }
    return (parsed as { cursor: string }).cursor;
  }

  async set(openKfid: string, cursor: string): Promise<void> {
    validateOpenKfid(openKfid);
    if (!cursor) throw new Error('wechat-kf cursor is required');
    await writeFileAtomic(
      this.pathFor(openKfid),
      `${JSON.stringify({ openKfid, cursor })}\n`,
      { mode: 0o600 },
    );
  }

  private pathFor(openKfid: string): string {
    validateOpenKfid(openKfid);
    const key = createHash('sha256').update(openKfid).digest('hex');
    return join(this.directory, `${key}.json`);
  }
}

function validateOpenKfid(value: string): void {
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(value)) throw new Error('invalid wechat-kf openKfid');
}
