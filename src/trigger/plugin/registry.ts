import { TriggerProviderError } from './errors';
import type {
  TriggerInstanceRef,
  TriggerProvider,
  TriggerProviderConfig,
  TriggerProviderContext,
  TriggerRuntime,
} from './types';
import {
  assertResolvedTriggerInstance,
  assertTriggerDrainOptions,
  assertTriggerDrainResult,
  assertTriggerEnvelope,
  assertTriggerHealthSnapshot,
  assertTriggerIngressAcceptance,
  assertTriggerProvider,
  assertTriggerRuntime,
  assertTriggerRuntimeSnapshot,
  triggerRuntimeKey,
} from './validation';

/** Owns registered trigger implementations and started instance lifecycles. */
export class TriggerProviderRegistry {
  private readonly providers = new Map<string, TriggerProvider>();
  private readonly active = new Map<string, TriggerRuntime>();
  private readonly starting = new Set<string>();

  register(provider: TriggerProvider): void {
    assertTriggerProvider(provider);
    const id = provider.manifest.id;
    const existing = this.providers.get(id);
    if (existing === provider) return;
    if (existing) throw configuration(`trigger provider already registered: ${id}`);
    this.providers.set(id, provider);
  }

  unregister(id: string): boolean {
    if (this.activeCount(id) > 0) throw configuration(`cannot unregister active trigger provider: ${id}`);
    return this.providers.delete(id);
  }

  get(id: string): TriggerProvider | undefined { return this.providers.get(id) }
  require(id: string): TriggerProvider {
    const provider = this.get(id);
    if (!provider) throw new TriggerProviderError(`unsupported trigger provider: ${id}`, { kind: 'unsupported-capability', code: 'unsupported-trigger-provider' });
    return provider;
  }
  list(): TriggerProvider[] { return [...this.providers.values()] }
  activeCount(providerId?: string): number {
    if (!providerId) return this.active.size;
    return [...this.active.values()].filter((runtime) => runtime.instance.providerId === providerId).length;
  }
  getActive(ref: TriggerInstanceRef): TriggerRuntime | undefined { return this.active.get(triggerRuntimeKey(ref)) }

  async start<TConfig extends TriggerProviderConfig>(id: string, context: TriggerProviderContext<TConfig>): Promise<TriggerRuntime> {
    if (context.signal.aborted) throw abortError();
    const provider = this.require(id) as TriggerProvider<TConfig>;
    assertResolvedTriggerInstance(context.instance, provider.manifest);
    if (!context.instance.enabled) throw configuration(`cannot start disabled trigger instance: ${context.instance.instanceId}`);
    const key = triggerRuntimeKey(context.instance);
    if (this.active.has(key) || this.starting.has(key)) throw configuration(`trigger instance already active: ${context.instance.instanceId}`);
    this.starting.add(key);
    let raw: TriggerRuntime | undefined;
    try {
      const instance = { ...context.instance, config: provider.validateConfig(context.instance.config) };
      assertResolvedTriggerInstance(instance, provider.manifest);
      raw = await provider.start({
        instance,
        signal: context.signal,
        ingress: {
          accept: async (envelope) => {
            assertTriggerEnvelope(envelope, instance, provider.manifest.capabilities);
            const acceptance = await context.ingress.accept(envelope);
            assertTriggerIngressAcceptance(acceptance);
            return acceptance;
          },
        },
      });
      assertTriggerRuntime(raw, instance);
      let closePromise: Promise<void> | undefined;
      const runtime: TriggerRuntime = {
        instance: raw.instance,
        snapshot: () => {
          const snapshot = raw!.snapshot();
          assertTriggerRuntimeSnapshot(snapshot, instance);
          return snapshot;
        },
        health: async () => {
          const health = await raw!.health();
          assertTriggerHealthSnapshot(health);
          return health;
        },
        drain: async (options) => {
          assertTriggerDrainOptions(options);
          const result = await raw!.drain(options);
          assertTriggerDrainResult(result);
          return result;
        },
        close: () => {
          if (!closePromise) closePromise = Promise.resolve().then(() => raw!.close()).finally(() => this.active.delete(key));
          return closePromise;
        },
      };
      this.active.set(key, runtime);
      return runtime;
    } catch (error) {
      if (raw) await Promise.resolve().then(() => raw!.close()).catch(() => undefined);
      throw error;
    } finally {
      this.starting.delete(key);
    }
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.active.values()].map((runtime) => runtime.close()));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'one or more trigger runtimes failed to close');
  }
}

function configuration(message: string): TriggerProviderError {
  return new TriggerProviderError(message, { kind: 'configuration', code: 'invalid-trigger-configuration' });
}
function abortError(): Error { const error = new Error('trigger provider start aborted'); error.name = 'AbortError'; return error }
