/** Profile-owned admission barrier. Already accepted callbacks and their
 * deferred continuations remain observable until they finish. Queued runs may
 * drain normally; pausing ingress never interrupts the executor. */
export class IngressFence {
  private readonly pauses = new Set<symbol>();
  private active = 0;

  pause(): () => void {
    const key = Symbol('ingress-pause');
    this.pauses.add(key);
    return () => { this.pauses.delete(key); };
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pauses.size) return Promise.reject(new Error('profile-transition-in-progress; ingress was not accepted'));
    return this.continue(operation);
  }

  /** Only for a continuation of an already accepted callback. */
  async continue<T>(operation: () => Promise<T>): Promise<T> {
    this.active++;
    try { return await operation(); } finally { this.active--; }
  }

  snapshot() { return { preparingRuns: this.active, quiescing: this.pauses.size > 0 }; }
}
