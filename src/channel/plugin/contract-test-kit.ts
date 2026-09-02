import { ChannelPluginRegistry } from './registry';
import type {
  ChannelConfig,
  ChannelDeliveryReceipt,
  ChannelDrainResult,
  ChannelHealthSnapshot,
  ChannelInboundEnvelope,
  ChannelIngressAcceptance,
  ChannelOutboundIntent,
  ChannelPlugin,
  ChannelRuntimeSnapshot,
  ResolvedChannelInstance,
} from './types';

export interface ChannelPluginContractOptions<
  TConfig extends ChannelConfig = ChannelConfig,
> {
  plugin: ChannelPlugin<TConfig>;
  instance: ResolvedChannelInstance<TConfig>;
  outboundIntent: ChannelOutboundIntent;
  acceptance?: ChannelIngressAcceptance;
  drainDeadlineAt?: number;
}

export interface ChannelPluginContractResult {
  acceptedInbound: readonly ChannelInboundEnvelope[];
  initialSnapshot: ChannelRuntimeSnapshot;
  health: ChannelHealthSnapshot;
  delivery: ChannelDeliveryReceipt;
  drain: ChannelDrainResult;
}

/**
 * Framework-neutral happy-path suite for built-in and external plugin packages.
 * Runtime validation is performed by the same registry used by Aria core.
 */
export async function runChannelPluginContract<
  TConfig extends ChannelConfig = ChannelConfig,
>(
  options: ChannelPluginContractOptions<TConfig>,
): Promise<ChannelPluginContractResult> {
  const acceptedInbound: ChannelInboundEnvelope[] = [];
  const registry = new ChannelPluginRegistry();
  registry.register(options.plugin);

  const runtime = await registry.start(options.plugin.manifest.id, {
    instance: options.instance,
    signal: new AbortController().signal,
    ingress: {
      accept: async (envelope) => {
        acceptedInbound.push(envelope);
        return (
          options.acceptance ?? {
            status: 'accepted',
            receiptId: `contract:${envelope.sourceMessageId}`,
          }
        );
      },
    },
  });

  try {
    const initialSnapshot = runtime.snapshot();
    const health = await runtime.health();
    const delivery = await runtime.deliver(options.outboundIntent);
    const drain = await runtime.drain({
      deadlineAt: options.drainDeadlineAt ?? Date.now() + 30_000,
    });
    return {
      acceptedInbound,
      initialSnapshot,
      health,
      delivery,
      drain,
    };
  } finally {
    await runtime.close();
    await runtime.close();
    if (registry.activeCount() !== 0) {
      throw new Error('channel contract left an active runtime after close');
    }
  }
}
