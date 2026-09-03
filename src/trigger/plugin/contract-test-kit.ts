import { TriggerProviderRegistry } from './registry';
import type {
  ResolvedTriggerInstance,
  TriggerEnvelope,
  TriggerHealthSnapshot,
  TriggerProvider,
  TriggerProviderConfig,
  TriggerRuntimeSnapshot,
} from './types';

export interface TriggerProviderContractOptions<TConfig extends TriggerProviderConfig = TriggerProviderConfig> {
  provider: TriggerProvider<TConfig>;
  instance: ResolvedTriggerInstance<TConfig>;
  acceptance?: { status: 'accepted' | 'duplicate'; receiptId: string };
  drainDeadlineAt?: number;
}

export interface TriggerProviderContractResult {
  accepted: readonly TriggerEnvelope[];
  initialSnapshot: TriggerRuntimeSnapshot;
  health: TriggerHealthSnapshot;
  drain: { drained: boolean; remainingEvents: number };
}

export async function runTriggerProviderContract<TConfig extends TriggerProviderConfig = TriggerProviderConfig>(
  options: TriggerProviderContractOptions<TConfig>,
): Promise<TriggerProviderContractResult> {
  const accepted: TriggerEnvelope[] = [];
  const registry = new TriggerProviderRegistry();
  registry.register(options.provider);
  const runtime = await registry.start(options.provider.manifest.id, {
    instance: options.instance,
    signal: new AbortController().signal,
    ingress: {
      accept: async (envelope) => {
        accepted.push(envelope);
        return options.acceptance ?? { status: 'accepted', receiptId: `contract:${envelope.sourceEventId}` };
      },
    },
  });
  try {
    return {
      accepted,
      initialSnapshot: runtime.snapshot(),
      health: await runtime.health(),
      drain: await runtime.drain({ deadlineAt: options.drainDeadlineAt ?? Date.now() + 30_000 }),
    };
  } finally {
    await runtime.close();
    await runtime.close();
    if (registry.activeCount() !== 0) throw new Error('trigger contract left an active runtime after close');
  }
}
