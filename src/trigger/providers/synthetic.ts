import {
  TRIGGER_PROVIDER_ABI_VERSION,
  type TriggerIngressAcceptance,
  type TriggerProvider,
  type TriggerProviderConfig,
  type TriggerRuntime,
} from '../plugin';
import type { JsonValue } from '../../session/jcs';

export interface SyntheticEvent {
  id: string;
  occurredAt: number;
  data: JsonValue;
}

export type SyntheticEventListener = (event: SyntheticEvent) => Promise<TriggerIngressAcceptance>;

export interface SyntheticEventSource {
  subscribe(listener: SyntheticEventListener): () => void;
}

/** In-process event source for contract tests and embedding adapters. */
export class InMemorySyntheticEventSource implements SyntheticEventSource {
  private readonly listeners = new Set<SyntheticEventListener>();

  subscribe(listener: SyntheticEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener) };
  }

  async publish(event: SyntheticEvent): Promise<readonly TriggerIngressAcceptance[]> {
    return Promise.all([...this.listeners].map((listener) => listener(structuredClone(event))));
  }

  listenerCount(): number { return this.listeners.size }
}

export type SyntheticTriggerConfig = TriggerProviderConfig & {
  definitionId: string;
  scopeRef: string;
  actorRef: string;
};

export function createSyntheticTriggerProvider(source: SyntheticEventSource): TriggerProvider<SyntheticTriggerConfig> {
  return {
    manifest: {
      abiVersion: TRIGGER_PROVIDER_ABI_VERSION,
      id: 'synthetic-event',
      displayName: 'Synthetic Event',
      package: { name: '@maxverse-ai/aria-trigger-synthetic', version: '1.0.0' },
      configVersion: 1,
      configSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['definitionId', 'scopeRef', 'actorRef'],
        properties: {
          definitionId: { type: 'string' },
          scopeRef: { type: 'string' },
          actorRef: { type: 'string' },
        },
      },
      capabilities: {
        ingress: 'push',
        sources: ['internal-event'],
        replay: 'source-event-id',
        acknowledgements: true,
      },
    },
    validateConfig: validateSyntheticTriggerConfig,
    async start(context): Promise<TriggerRuntime> {
      let state: 'ready' | 'draining' | 'stopped' = 'ready';
      let updatedAt = Date.now();
      const inFlight = new Set<Promise<TriggerIngressAcceptance>>();
      const unsubscribe = source.subscribe(async (event) => {
        if (state !== 'ready' || context.signal.aborted) throw abortError();
        const acceptance = context.ingress.accept({
          abiVersion: TRIGGER_PROVIDER_ABI_VERSION,
          profileId: context.instance.profileId,
          providerId: context.instance.providerId,
          instanceId: context.instance.instanceId,
          sourceKind: 'internal-event',
          sourceEventId: event.id,
          triggerDefinitionId: context.instance.config.definitionId,
          occurredAt: event.occurredAt,
          observedAt: Date.now(),
          scopeRef: context.instance.config.scopeRef,
          actor: { kind: 'system', actorRef: context.instance.config.actorRef },
          data: event.data,
        });
        inFlight.add(acceptance);
        try { return await acceptance } finally { inFlight.delete(acceptance) }
      });
      const stop = (): void => {
        if (state === 'stopped') return;
        unsubscribe();
        state = 'stopped';
        updatedAt = Date.now();
      };
      const onAbort = (): void => { stop() };
      context.signal.addEventListener('abort', onAbort, { once: true });
      let closePromise: Promise<void> | undefined;
      return {
        instance: {
          profileId: context.instance.profileId,
          providerId: context.instance.providerId,
          instanceId: context.instance.instanceId,
        },
        snapshot: () => ({
          profileId: context.instance.profileId,
          providerId: context.instance.providerId,
          instanceId: context.instance.instanceId,
          state,
          acceptingEvents: state === 'ready' && !context.signal.aborted,
          inFlightEvents: inFlight.size,
          updatedAt,
        }),
        health: async () => ({
          status: state === 'ready' && !context.signal.aborted ? 'healthy' : 'unhealthy',
          checkedAt: Date.now(),
          ...(state === 'ready' && !context.signal.aborted ? {} : { code: 'synthetic-source-stopped' }),
        }),
        drain: async ({ deadlineAt }) => {
          if (state === 'ready') {
            unsubscribe();
            state = 'draining';
            updatedAt = Date.now();
          }
          while (inFlight.size > 0 && Date.now() < deadlineAt) {
            await Promise.race([...inFlight, delay(Math.max(0, deadlineAt - Date.now()))]);
          }
          return { drained: inFlight.size === 0, remainingEvents: inFlight.size };
        },
        close: () => {
          closePromise ??= Promise.resolve().then(() => {
            context.signal.removeEventListener('abort', onAbort);
            stop();
          });
          return closePromise;
        },
      };
    },
  };
}

function validateSyntheticTriggerConfig(value: unknown): SyntheticTriggerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidConfig();
  const config = value as Record<string, unknown>;
  const keys = Object.keys(config);
  if (keys.length !== 3 || keys.some((key) => !['definitionId', 'scopeRef', 'actorRef'].includes(key))) invalidConfig();
  for (const key of ['definitionId', 'scopeRef', 'actorRef'] as const) {
    if (typeof config[key] !== 'string' || config[key].length === 0 || config[key].length > 512) invalidConfig();
  }
  return {
    definitionId: config.definitionId as string,
    scopeRef: config.scopeRef as string,
    actorRef: config.actorRef as string,
  };
}

function invalidConfig(): never { throw new Error('synthetic trigger config is invalid') }
function abortError(): Error { const error = new Error('synthetic trigger source is not accepting events'); error.name = 'AbortError'; return error }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
