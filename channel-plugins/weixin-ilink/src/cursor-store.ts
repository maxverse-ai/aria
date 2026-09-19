import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Durable provider-cursor boundary. The get_updates_buf cursor may advance
 * only after ordered durable acceptance of the envelopes it covers
 * (docs/WEIXIN_ILINK_PROTOCOL.md — inbound path).
 */
export interface IlinkCursorStore {
  read(): Promise<string>;
  write(cursor: string): Promise<void>;
}

/** Volatile store for tests and the Stage 11B skeleton. */
export class InMemoryCursorStore implements IlinkCursorStore {
  private cursor: string;
  readonly writes: string[] = [];

  constructor(initial = '') {
    this.cursor = initial;
  }

  async read(): Promise<string> {
    return this.cursor;
  }

  async write(cursor: string): Promise<void> {
    this.cursor = cursor;
    this.writes.push(cursor);
  }
}

/**
 * Atomic single-file cursor store for deployments. Writes go through a
 * same-directory rename so a crash never leaves a half-written cursor; a
 * missing or empty file reads as the empty first-poll cursor.
 */
export class FileIlinkCursorStore implements IlinkCursorStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<string> {
    try {
      return (await readFile(this.filePath, 'utf8')).trim();
    } catch {
      return '';
    }
  }

  async write(cursor: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = join(
      dirname(this.filePath),
      `.${Math.random().toString(36).slice(2)}.tmp`,
    );
    await writeFile(temp, cursor, { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}
