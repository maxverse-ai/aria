import type { BridgeChannel } from '../bot/channel';
import { createBuiltInLarkChannelPlugin } from '../bot/channel-plugin';
import type { LarkChannelConfig } from '../channel/instance-resolver';
import type { LarkChannelOwnershipPolicy } from '../channel/lark-ownership';
import { ChannelManager, type ChannelManagerSnapshot } from '../channel/manager';
import { ChannelPluginError } from '../channel/plugin/errors';
import { ChannelPluginRegistry } from '../channel/plugin/registry';
import type {
  ChannelIngressPort,
  ResolvedChannelInstance,
} from '../channel/plugin/types';

export interface ProfileLarkChannelRuntime {
  readonly policy: Readonly<LarkChannelOwnershipPolicy>;
  readonly bridge: BridgeChannel;
  readonly manager?: ChannelManager;
  snapshot(): ChannelManagerSnapshot | undefined;
  close(): Promise<void>;
}

export interface StartProfileLarkChannelRuntimeOptions {
  profileId: string;
  policy: Readonly<LarkChannelOwnershipPolicy>;
  instance: ResolvedChannelInstance<LarkChannelConfig>;
  startBridge(): Promise<BridgeChannel>;
}

const TRANSITIONAL_LARK_INGRESS: ChannelIngressPort = Object.freeze({
  accept: async () => {
    throw new ChannelPluginError('normalized Lark ingress is not enabled in this rollout stage', {
      kind: 'unsupported-capability',
      code: 'lark-normalized-ingress-not-enabled',
    });
  },
});

/** Start exactly one authoritative Lark transport for a profile. */
export async function startProfileLarkChannelRuntime(
  options: StartProfileLarkChannelRuntimeOptions,
): Promise<ProfileLarkChannelRuntime> {
  let manager: ChannelManager | undefined;
  let bridge: BridgeChannel | undefined;
  try {
    if (options.policy.managerEnabled) {
      const registry = new ChannelPluginRegistry();
      const adapter = createBuiltInLarkChannelPlugin({ startBridge: options.startBridge });
      if (options.policy.owner === 'manager') registry.register(adapter.plugin);
      manager = new ChannelManager({ profileId: options.profileId, registry });
      const plans = options.policy.owner === 'manager'
        ? [{ instance: options.instance, ingress: TRANSITIONAL_LARK_INGRESS }]
        : [];
      await manager.start(plans);
      if (options.policy.owner === 'manager') {
        bridge = adapter.bridgeFor(options.instance);
        if (!bridge) {
          throw new ChannelPluginError('Lark plugin started without an active bridge', {
            kind: 'permanent',
            code: 'lark-bridge-unavailable',
          });
        }
      }
    }

    if (options.policy.owner === 'legacy') {
      bridge = await options.startBridge();
    }
    if (!bridge) {
      throw new ChannelPluginError('Lark channel runtime has no lifecycle owner', {
        kind: 'configuration',
        code: 'lark-channel-owner-unavailable',
      });
    }

    return createHandle(options.policy, bridge, manager);
  } catch (error) {
    await manager?.close().catch(() => undefined);
    if (bridge && options.policy.owner === 'legacy') {
      await bridge.disconnect().catch(() => undefined);
    }
    throw error;
  }
}

function createHandle(
  policy: Readonly<LarkChannelOwnershipPolicy>,
  bridge: BridgeChannel,
  manager: ChannelManager | undefined,
): ProfileLarkChannelRuntime {
  let closePromise: Promise<void> | undefined;
  return {
    policy,
    bridge,
    ...(manager ? { manager } : {}),
    snapshot: () => manager?.snapshot(),
    close: () => {
      if (!closePromise) {
        closePromise = closeOwnedRuntime(policy, bridge, manager);
      }
      return closePromise;
    },
  };
}

async function closeOwnedRuntime(
  policy: Readonly<LarkChannelOwnershipPolicy>,
  bridge: BridgeChannel,
  manager: ChannelManager | undefined,
): Promise<void> {
  const failures: unknown[] = [];
  if (manager) {
    await manager.close().catch((error) => failures.push(error));
  }
  if (policy.owner === 'legacy') {
    await bridge.disconnect().catch((error) => failures.push(error));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Lark channel runtime failed to close');
  }
}
