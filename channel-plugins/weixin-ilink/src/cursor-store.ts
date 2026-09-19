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
