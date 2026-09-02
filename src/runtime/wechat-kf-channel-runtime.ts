import { ChannelManager, type ChannelManagerSnapshot } from '../channel/manager';
import { ChannelPluginRegistry } from '../channel/plugin/registry';
import type { ChannelIngressPort, ResolvedChannelInstance } from '../channel/plugin/types';
import {
  createBuiltInWechatKfChannelPlugin,
  type WechatKfChannelBridge,
  type WechatKfChannelConfig,
} from '../channel/wechat-kf/channel-plugin';
import type { WechatKfChannelOwnershipPolicy } from '../channel/wechat-kf/ownership';

export interface ProfileWechatKfChannelRuntime {
  readonly policy: Readonly<WechatKfChannelOwnershipPolicy>;
  readonly bridge: WechatKfChannelBridge;
  readonly manager?: ChannelManager;
  snapshot(): ChannelManagerSnapshot | undefined;
  close(): Promise<void>;
}

export interface StartProfileWechatKfChannelRuntimeOptions {
  profileId: string;
  policy: Readonly<WechatKfChannelOwnershipPolicy>;
  instance: ResolvedChannelInstance<WechatKfChannelConfig>;
  ingress: ChannelIngressPort;
  startBridge(
    instance: ResolvedChannelInstance<WechatKfChannelConfig>,
  ): Promise<WechatKfChannelBridge>;
}

/** Starts exactly one authoritative wxkf callback/sync bridge. */
export async function startProfileWechatKfChannelRuntime(
  options: StartProfileWechatKfChannelRuntimeOptions,
): Promise<ProfileWechatKfChannelRuntime> {
  let manager: ChannelManager | undefined;
  let bridge: WechatKfChannelBridge | undefined;
  try {
    if (options.policy.managerEnabled) {
      const registry = new ChannelPluginRegistry();
      const adapter = createBuiltInWechatKfChannelPlugin({ startBridge: options.startBridge });
      if (options.policy.owner === 'manager') registry.register(adapter.plugin);
      manager = new ChannelManager({ profileId: options.profileId, registry });
      await manager.start(options.policy.owner === 'manager'
        ? [{ instance: options.instance, ingress: options.ingress }]
        : []);
      if (options.policy.owner === 'manager') bridge = adapter.bridgeFor(options.instance);
    }
    if (options.policy.owner === 'legacy') bridge = await options.startBridge(options.instance);
    if (!bridge) throw new Error('wxkf channel runtime has no lifecycle owner');
    return createHandle(options.policy, bridge, manager);
  } catch (error) {
    await manager?.close().catch(() => undefined);
    if (bridge && options.policy.owner === 'legacy') await bridge.close().catch(() => undefined);
    throw error;
  }
}

function createHandle(
  policy: Readonly<WechatKfChannelOwnershipPolicy>,
  bridge: WechatKfChannelBridge,
  manager: ChannelManager | undefined,
): ProfileWechatKfChannelRuntime {
  let closePromise: Promise<void> | undefined;
  return {
    policy,
    bridge,
    ...(manager ? { manager } : {}),
    snapshot: () => manager?.snapshot(),
    close: () => {
      closePromise ??= closeOwned(policy, bridge, manager);
      return closePromise;
    },
  };
}

async function closeOwned(
  policy: Readonly<WechatKfChannelOwnershipPolicy>,
  bridge: WechatKfChannelBridge,
  manager: ChannelManager | undefined,
): Promise<void> {
  const failures: unknown[] = [];
  await manager?.close().catch((error) => failures.push(error));
  if (policy.owner === 'legacy') await bridge.close().catch((error) => failures.push(error));
  if (failures.length > 0) {
    throw new AggregateError(failures, 'wxkf channel runtime failed to close');
  }
}
