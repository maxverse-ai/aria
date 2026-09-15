import type { AuthorizedSpaceContext } from '../space/authorization';
import type { AgentAdapter } from '../agent/types';
import { createAdapterRuntime } from '../agent/runtime/adapter-runtime';
import type { EngineRuntime } from '../agent/runtime/types';

/** Internal host contract; neither a plugin ABI nor an authorization token. */
export interface RuntimeAcquisition {
  readonly scopeId: string;
  readonly spaceContext?: AuthorizedSpaceContext;
  readonly purpose: 'run' | 'query';
  readonly runId?: string;
}

export interface RuntimeLease {
  readonly generation: number;
  readonly runtime: EngineRuntime;
  readonly released: boolean;
  /** Trusted, short per-acquisition context; never saved to the native session catalog. */
  readonly instructions?: string;
  release(): void;
}

export interface RuntimeProvider {
  acquire(input: RuntimeAcquisition): RuntimeLease | Promise<RuntimeLease>;
  dispose(): Promise<void>;
}

/** One immutable owner. Retirement fences acquisition and waits for borrowers. */
export class RuntimeGeneration {
  private references = 0;
  private closing = false;
  private drain?: () => void;
  private disposal?: Promise<void>;

  constructor(readonly runtime: EngineRuntime, readonly generation: number) {}

  acquire(): RuntimeLease {
    if (this.closing) throw new Error('runtime generation is closing');
    this.references++;
    let released = false;
    return Object.freeze({
      generation: this.generation,
      runtime: this.runtime,
      get released() { return released; },
      release: () => {
        if (released) return;
        released = true;
        this.references--;
        if (this.references === 0) this.drain?.();
      },
    });
  }

  get activeReferences(): number { return this.references; }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.closing = true;
      this.disposal = (async () => {
        if (this.references > 0) {
          await new Promise<void>((resolve) => { this.drain = resolve; });
        }
        await this.runtime.dispose();
      })();
    }
    return this.disposal;
  }
}

/** Compatibility for callers supplying only an existing one-shot adapter. */
export function fixedAdapterRuntimeProvider(agent: AgentAdapter): RuntimeProvider {
  const owner = new RuntimeGeneration(createAdapterRuntime(agent), 1);
  return {
    acquire: () => owner.acquire(),
    dispose: () => owner.dispose(),
  };
}

export async function queryRuntime<T>(
  provider: RuntimeProvider,
  scopeId: string,
  query: (runtime: EngineRuntime) => Promise<T>,
): Promise<T> {
  const lease = await provider.acquire({ scopeId, purpose: 'query' });
  try { return await query(lease.runtime); }
  finally { lease.release(); }
}
