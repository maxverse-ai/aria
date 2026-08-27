import type { AgentAdapter, AgentBotIdentity, AgentRun, AgentRunOptions } from '../agent/types';
import type { EngineRuntime, EngineStatusSnapshot } from '../agent/runtime/types';
import type { ModelOption } from '../agent/models';

/**
 * Stable profile-level routing point for the currently active agent runtime.
 *
 * Feishu handlers and RunExecutor keep this adapter for the lifetime of the
 * channel. An agent switch only replaces the runtime behind the slot, so the
 * WebSocket connection and event subscriptions do not need to be rebuilt.
 */
export class ProfileRuntimeSlot {
  private static readonly STATUS_TTL_MS = 60_000;

  private runtime: EngineRuntime;
  private generation = 1;
  private botIdentity: AgentBotIdentity | undefined;
  private statusCache:
    | { generation: number; expiresAt: number; value: EngineStatusSnapshot }
    | undefined;
  private statusInFlight:
    | { generation: number; promise: Promise<EngineStatusSnapshot | undefined> }
    | undefined;

  readonly execution: AgentAdapter;

  constructor(runtime: EngineRuntime) {
    this.runtime = runtime;
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
      setBotIdentity: (identity: AgentBotIdentity) => slot.setBotIdentity(identity),
    };
  }

  current(): EngineRuntime {
    return this.runtime;
  }

  currentGeneration(): number {
    return this.generation;
  }

  listModels(signal: AbortSignal): Promise<ModelOption[] | undefined> {
    const provider = this.runtime.listModels;
    return provider ? provider.call(this.runtime, signal) : Promise.resolve(undefined);
  }

  statusSnapshot(): Promise<EngineStatusSnapshot | undefined> {
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
    const promise = provider.call(this.runtime).then((value) => {
      if (this.generation === generation) {
        this.statusCache = {
          generation,
          expiresAt: Date.now() + ProfileRuntimeSlot.STATUS_TTL_MS,
          value,
        };
      }
      return value;
    }).finally(() => {
      if (this.statusInFlight?.promise === promise) this.statusInFlight = undefined;
    });
    this.statusInFlight = { generation, promise };
    return promise;
  }

  /** Swap is synchronous and cannot expose a half-updated routing state. */
  swap(next: EngineRuntime): EngineRuntime {
    if (this.botIdentity) next.execution.setBotIdentity?.(this.botIdentity);
    const previous = this.runtime;
    this.runtime = next;
    this.generation++;
    this.statusCache = undefined;
    this.statusInFlight = undefined;
    return previous;
  }

  private setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
    this.runtime.execution.setBotIdentity?.(identity);
  }
}
