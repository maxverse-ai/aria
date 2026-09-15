import type { AgentAdapter, AgentRun, AgentRunOptions } from '../agent/types';
import type {
  EngineRuntime,
  EngineRuntimeDescriptor,
  EngineStatusSnapshot,
} from '../agent/runtime/types';
import type { ModelOption } from '../agent/models';
import { RuntimeGeneration, type RuntimeAcquisition, type RuntimeLease, type RuntimeProvider } from './runtime-provider';

/**
 * Stable profile-level routing point for the currently active agent runtime.
 *
 * Feishu handlers and RunExecutor keep this adapter for the lifetime of the
 * channel. An agent switch only replaces the runtime behind the slot, so the
 * WebSocket connection and event subscriptions do not need to be rebuilt.
 */
export class ProfileRuntimeSlot implements RuntimeProvider {
  private static readonly STATUS_TTL_MS = 60_000;

  private runtime: EngineRuntime;
  private generation = 1;
  private owner: RuntimeGeneration;
  private readonly owners = new Map<EngineRuntime, RuntimeGeneration>();
  private closed = false;
  private disposal?: Promise<void>;
  private statusCache:
    | { generation: number; expiresAt: number; value: EngineStatusSnapshot }
    | undefined;
  private statusInFlight:
    | { generation: number; promise: Promise<EngineStatusSnapshot | undefined> }
    | undefined;

  readonly execution: AgentAdapter;

  constructor(runtime: EngineRuntime) {
    this.runtime = runtime;
    this.owner = new RuntimeGeneration(runtime, this.generation);
    this.owners.set(runtime, this.owner);
    const slot = this;
    this.execution = {
      get id() {
        return slot.runtime.execution.id;
      },
      get displayName() {
        return slot.runtime.execution.displayName;
      },
      isAvailable: () => slot.runtime.execution.isAvailable(),
      prepareRun: (opts: AgentRunOptions) => {
        const prepare = slot.runtime.execution.prepareRun;
        return prepare ? prepare.call(slot.runtime.execution, opts) : Promise.resolve();
      },
      run: (opts: AgentRunOptions): AgentRun => slot.runtime.execution.run(opts),
    };
  }

  current(): EngineRuntime {
    return this.runtime;
  }

  acquire(_input: RuntimeAcquisition): RuntimeLease {
    if (this.closed) throw new Error('profile runtime slot is closed');
    return this.owner.acquire();
  }

  disposeRuntime(runtime: EngineRuntime): Promise<void> {
    const owner = this.owners.get(runtime);
    if (!owner) return Promise.reject(new Error('runtime does not belong to this slot'));
    return owner.dispose();
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.closed = true;
      this.disposal = Promise.all([...this.owners.values()].map((owner) => owner.dispose()))
        .then(() => undefined);
    }
    return this.disposal;
  }

  currentGeneration(): number {
    return this.generation;
  }

  descriptor(): EngineRuntimeDescriptor {
    return this.runtime.descriptor;
  }

  listModels(signal: AbortSignal): Promise<ModelOption[] | undefined> {
    const lease = this.acquire({ scopeId: 'profile-models', purpose: 'query' });
    return Promise.resolve().then(() => lease.runtime.listModels?.(signal))
      .finally(() => lease.release());
  }

  statusSnapshot(): Promise<EngineStatusSnapshot | undefined> {
    if (this.closed) return Promise.reject(new Error('profile runtime slot is closed'));
    const now = Date.now();
    if (
      this.statusCache?.generation === this.generation
      && this.statusCache.expiresAt > now
    ) {
      return Promise.resolve(this.statusCache.value);
    }
    if (this.statusInFlight?.generation === this.generation) {
      return this.statusInFlight.promise;
    }
    const provider = this.runtime.statusSnapshot;
    if (!provider) return Promise.resolve(undefined);

    const generation = this.generation;
    const lease = this.acquire({ scopeId: 'profile-status', purpose: 'query' });
    let result: Promise<EngineStatusSnapshot>;
    try { result = provider.call(lease.runtime); }
    catch (error) { lease.release(); return Promise.reject(error); }
    const promise = result.then((value) => {
      if (this.generation === generation) {
        this.statusCache = {
          generation,
          expiresAt: Date.now() + ProfileRuntimeSlot.STATUS_TTL_MS,
          value,
        };
      }
      return value;
    }).finally(() => {
      lease.release();
      if (this.statusInFlight?.promise === promise) this.statusInFlight = undefined;
    });
    this.statusInFlight = { generation, promise };
    return promise;
  }

  /** Swap is synchronous and cannot expose a half-updated routing state. */
  swap(next: EngineRuntime): EngineRuntime {
    if (this.closed) throw new Error('profile runtime slot is closed');
    if (this.owners.has(next)) throw new Error('runtime generation cannot be reused');
    const previous = this.runtime;
    this.runtime = next;
    this.generation++;
    this.owner = new RuntimeGeneration(next, this.generation);
    this.owners.set(next, this.owner);
    this.statusCache = undefined;
    this.statusInFlight = undefined;
    return previous;
  }

}
