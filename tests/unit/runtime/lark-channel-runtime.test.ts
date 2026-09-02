import { describe, expect, it, vi } from 'vitest';
import type { BridgeChannel } from '../../../src/bot/channel';
import { projectSchemaV2ChannelInstances } from '../../../src/channel/instance-resolver';
import {
  resolveLarkChannelOwnership,
  type LarkChannelRolloutMode,
} from '../../../src/channel/lark-ownership';
import { startProfileLarkChannelRuntime } from '../../../src/runtime/lark-channel-runtime';

function instance() {
  return projectSchemaV2ChannelInstances({
    profileId: 'work',
    profile: {
      schemaVersion: 2,
      accounts: { app: { id: 'cli_app', secret: '${APP_SECRET}', tenant: 'feishu' } },
    },
  })[0];
}

function fakeBridge(): {
  bridge: BridgeChannel;
  quiesce: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const quiesce = vi.fn(async () => vi.fn());
  const disconnect = vi.fn(async () => undefined);
  return {
    bridge: {
      channel: { send: vi.fn() } as unknown as BridgeChannel['channel'],
      activitySnapshot: () => undefined as never,
      quiesceAgentRuns: quiesce,
      disconnect,
    },
    quiesce,
    disconnect,
  };
}

describe('profile Lark channel runtime composition', () => {
  it.each([
    ['off', 'legacy', undefined],
    ['shadow', 'legacy', 0],
    ['opt-in', 'manager', 1],
    ['default-on', 'manager', 1],
  ] as const)(
    'starts exactly one bridge in %s mode',
    async (mode, owner, managerInstanceCount) => {
      const transport = fakeBridge();
      const startBridge = vi.fn(async () => transport.bridge);
      const runtime = await startProfileLarkChannelRuntime({
        profileId: 'work',
        policy: resolveLarkChannelOwnership(mode as LarkChannelRolloutMode),
        instance: instance(),
        startBridge,
      });

      expect(runtime.policy.owner).toBe(owner);
      expect(startBridge).toHaveBeenCalledTimes(1);
      expect(runtime.snapshot()?.instanceCount).toBe(managerInstanceCount);
      expect(runtime.snapshot()?.instances.map((entry) => entry.pluginId) ?? []).not.toContain(
        'wechat-kf',
      );
      expect(runtime.snapshot()?.instances.map((entry) => entry.pluginId) ?? []).not.toContain(
        'weixin-ilink',
      );

      await runtime.close();
      await runtime.close();
      expect(transport.disconnect).toHaveBeenCalledTimes(1);
      expect(transport.quiesce).toHaveBeenCalledTimes(owner === 'manager' ? 1 : 0);
    },
  );
});
