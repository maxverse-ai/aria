import { log, reportMetric } from '../core/logger';

/**
 * FIFO concurrency cap for claude runs. Especially useful in topic-group
 * scenarios where each topic spawns its own run — without a cap, a single
 * busy group could trivially explode to dozens of concurrent claude
 * subprocesses, drowning RAM and Anthropic API rate limit.
 *
 * Use:
 *   const pool = new ProcessPool();
 *   const release = await pool.acquire();
 *   try { ... } finally { release(); }
 *
 * The cap is read fresh each `acquire()`, so `/config maxConcurrentRuns`
 * takes effect for the next run that asks for a slot.
 */
export class ProcessPool {
  private active = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];
  /** Snapshot of the cap captured at the moment acquire() decided to wait. */
  private cap: () => number;

  constructor(cap: () => number) {
    this.cap = cap;
  }

  async acquire(): Promise<() => void> {
    this.drain();
    if (this.waiters.length === 0 && this.active < this.cap()) {
      this.active++;
      log.info('pool', 'acquired', { active: this.active, cap: this.cap() });
      reportMetric('pool_active', this.active);
      return this.permit();
    }
    log.info('pool', 'wait', { active: this.active, cap: this.cap(), waiting: this.waiters.length + 1 });
    reportMetric('pool_waiting', this.waiters.length + 1);
    return new Promise<() => void>((resolve) => this.waiters.push(resolve));
  }

  tryAcquire(): (() => void) | undefined {
    this.drain();
    if (this.waiters.length > 0 || this.active >= this.cap()) {
      log.info('pool', 'full', { active: this.active, cap: this.cap() });
      return undefined;
    }
    this.active++;
    log.info('pool', 'acquired', { active: this.active, cap: this.cap() });
    return this.permit();
  }

  private permit(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    log.info('pool', 'released', { active: this.active });
    reportMetric('pool_active', this.active);
    // Wake the next waiter if there's headroom. If cap was just lowered
    // via /config, this naturally throttles by not waking.
    this.drain();
  }

  private drain(): void {
    while (this.active < this.cap() && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      this.active++;
      next(this.permit());
    }
    reportMetric('pool_active', this.active);
    reportMetric('pool_waiting', this.waiters.length);
  }

  snapshot(): { active: number; waiting: number; cap: number } {
    return { active: this.active, waiting: this.waiters.length, cap: this.cap() };
  }
}
