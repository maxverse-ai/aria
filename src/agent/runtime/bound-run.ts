import type { AgentRun, AgentEvent } from '../types';

/** Lazy streams and later control calls retain the native launch/presentation context. */
export function bindAgentRun(run: AgentRun, bind: <T>(operation: () => T) => T): AgentRun {
  return {
    runId: run.runId,
    get steering() {
      return run.steering;
    },
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
        const iterator = bind(() => run.events[Symbol.asyncIterator]());
        try {
          while (true) {
            const next = await bind(() => iterator.next());
            if (next.done) return;
            yield next.value;
          }
        } finally { await bind(() => iterator.return?.()); }
      },
    },
    ...(run.steer ? { steer: (input) => bind(() => run.steer!(input)) } : {}),
    stop: () => bind(() => run.stop()),
    waitForExit: (timeout) => bind(() => run.waitForExit(timeout)),
  };
}
