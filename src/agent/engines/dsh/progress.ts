import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { AgentEvent } from '../../types';
import { DSH_PROGRESS_PLUGIN } from './progress-plugin';

/** Per-process extension files. The process close event owns their lifetime. */
export function prepareDshProgress(stateDir: string): { patch: string; cleanup(): void } {
  mkdirSync(stateDir, { recursive: true });
  const dir = mkdtempSync(join(stateDir, 'dsh-progress-'));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    const plugin = join(dir, 'progress.mjs');
    const patch = join(dir, 'patch.json');
    writeFileSync(plugin, DSH_PROGRESS_PLUGIN, { mode: 0o600 });
    writeFileSync(patch, JSON.stringify([
      { insert: [{ id: 'aria-dsh-progress', name: pathToFileURL(plugin).href }] },
      { id: 'headless-runner', inject: ['headlessStartup', 'ariaDshProgress'] },
    ]), { mode: 0o600 });
    return { patch, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Bounded decoder and queue for the private progress pipe, independent of stdout. */
export class DshProgress {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private queue: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  ready = false;
  error: Error | undefined;

  push(chunk: Buffer): void {
    if (this.closed || this.error) return;
    this.buffer += this.decoder.write(chunk);
    let end: number;
    try {
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        if (end > 128 * 1024) throw new Error('DSH progress frame exceeds limit');
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        const event = JSON.parse(line);
        if (event.type === 'ready' && event.version === 1 && !this.ready) {
          this.ready = true;
          continue;
        }
        if (!this.ready) throw new Error('DSH progress handshake missing');
        if (!validProgressEvent(event)) throw new Error('Invalid DSH progress event');
        if (this.queue.length >= 1024) throw new Error('DSH progress consumer exceeded queue limit');
        this.queue.push(event);
        this.wake?.();
      }
      if (this.buffer.length > 128 * 1024) throw new Error('DSH progress frame exceeds limit');
    } catch (error) {
      this.error = error instanceof Error ? error : new Error('Invalid DSH progress');
      this.wake?.();
    }
  }

  close(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) this.error ??= new Error('Truncated DSH progress frame');
    this.closed = true;
    this.wake?.();
  }

  async *events(): AsyncGenerator<AgentEvent> {
    while (true) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed || this.error) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

function validProgressEvent(event: Record<string, unknown>): event is Record<string, unknown> & AgentEvent {
  switch (event.type) {
    case 'system': return typeof event.sessionId === 'string';
    case 'text': return typeof event.delta === 'string';
    case 'tool_use': return typeof event.id === 'string' && typeof event.name === 'string';
    case 'tool_result': return typeof event.id === 'string' && typeof event.output === 'string' && typeof event.isError === 'boolean';
    default: return false;
  }
}
