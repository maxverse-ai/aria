import { describe, expect, it, vi } from 'vitest';
import { ChannelRuntimeAdmin } from '../../../src/runtime/channel-runtime-admin';
import type { ExternalChannelPluginComposition } from '../../../src/runtime/external-channel-runtime';
import type { ExternalChannelPluginPackageSource } from '../../../src/channel/plugin/loader';
import type {
  ChannelPlugin,
  ChannelRuntime,
  ChannelRuntimeSnapshot,
  ResolvedChannelInstance,
} from '../../../src/channel/plugin/types';
import {
  channelPluginPackage,
  NOOP_EXTERNAL_CHANNEL_PACKAGE,
  NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
  NOOP_EXTERNAL_CHANNEL_VERSION,
} from '../../fixtures/channel/noop-external-channel-plugin';

const request = Object.freeze({
  package: NOOP_EXTERNAL_CHANNEL_PACKAGE,
  version: NOOP_EXTERNAL_CHANNEL_VERSION,
});
const trust = Object.freeze({ ...request, pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID });

function instance(
  instanceId = 'primary',
  overrides: Partial<ResolvedChannelInstance> = {},
): ResolvedChannelInstance {
  return {
    profileId: 'fixture-profile',
    pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
    instanceId,
    enabled: true,
    configVersion: 1,
    config: { label: instanceId },
    secretRefs: {},
    ...overrides,
  };
}

function fakeRuntime(
  context: { instance: ResolvedChannelInstance },
  behavior: { inFlight?: number; failStart?: boolean; withAuth?: boolean } = {},
): ChannelRuntime {
  let snapshot: ChannelRuntimeSnapshot = {
    profileId: context.instance.profileId,
    pluginId: context.instance.pluginId,
    instanceId: context.instance.instanceId,
    state: 'ready',
    acceptingInbound: true,
    inFlightInbound: behavior.inFlight ?? 0,
    inFlightOutbound: 0,
    updatedAt: 1,
  };
  const runtime: ChannelRuntime = {
    instance: context.instance,
    snapshot: () => snapshot,
    health: async () => ({ status: 'healthy', checkedAt: 1 }),
    deliver: async (intent) => ({
      deliveryId: intent.deliveryId,
      status: 'sent',
      providerMessageId: `fake:${intent.deliveryId}`,
      deliveredAt: 1,
    }),
    drain: async () => {
      snapshot = { ...snapshot, state: 'draining', acceptingInbound: false };
      return { drained: true, remainingInbound: 0, remainingOutbound: 0 };
    },
    close: async () => {
      snapshot = { ...snapshot, state: 'stopped', acceptingInbound: false };
    },
  };
  if (behavior.withAuth !== false) {
    runtime.login = vi.fn(async () => ({ status: 'authenticated' as const }));
    runtime.logout = vi.fn(async () => ({ status: 'logged-out' as const }));
  }
  return runtime;
}

function plugin(behavior: { inFlight?: number; failStart?: boolean; withAuth?: boolean } = {}): ChannelPlugin {
  const base = channelPluginPackage.channelPlugin;
  return {
    ...base,
    async start(context): Promise<ChannelRuntime> {
      if (behavior.failStart) throw new Error('fixture start failed');
      return fakeRuntime(context, behavior);
    },
  };
}

function source(channelPlugin: ChannelPlugin = plugin()) {
  const value: ExternalChannelPluginPackageSource & {
    resolve: ReturnType<typeof vi.fn>;
    importModule: ReturnType<typeof vi.fn>;
  } = {
    resolve: vi.fn(async () => ({
      specifier: 'fixture:noop-channel',
      metadata: { name: request.package, version: request.version },
    })),
    importModule: vi.fn(async () => ({ channelPluginPackage: { channelPlugin } })),
  };
  return value;
}

function composition(packageSource = source()): ExternalChannelPluginComposition {
  return {
    trustedPackages: [trust],
    source: packageSource,
    createIngress: () => ({
      accept: async () => ({ status: 'accepted', receiptId: 'fixture-receipt' }),
    }),
  };
}

async function admin(
  packageSource = source(),
): Promise<ChannelRuntimeAdmin> {
  return ChannelRuntimeAdmin.start({
    profileId: 'fixture-profile',
    composition: composition(packageSource),
  });
}

function outcome(
  report: { outcomes: readonly { operation: string; instanceId?: string; status: string; code?: string }[] },
  operation: string,
  instanceId?: string,
) {
  return report.outcomes.find(
    (entry) => entry.operation === operation && entry.instanceId === instanceId,
  );
}

describe('channel runtime admin', () => {
  it('reconcile loads declared+trusted packages and starts only enabled instances', async () => {
    const packageSource = source();
    const target = await admin(packageSource);
    const report = await target.reconcile({
      requests: [request],
      instances: [instance(), instance('disabled', { enabled: false })],
    });
    expect(report.status).toBe('applied');
    expect(outcome(report, 'load-package')?.status).toBe('applied');
    expect(outcome(report, 'start', 'primary')?.status).toBe('applied');
    expect(target.snapshot().manager).toMatchObject({
      state: 'ready',
      instanceCount: 1,
      readyCount: 1,
    });
    await target.close();
  });

  it('reconcile is idempotent: a second pass skips start and consumes auth once', async () => {
    const channelPlugin = plugin();
    const target = await admin(source(channelPlugin));
    const desired = instance('primary', {
      auth: { intent: 'login', requestedAt: '2026-09-19T00:00:00.000Z' },
    });
    const first = await target.reconcile({ requests: [request], instances: [desired] });
    expect(outcome(first, 'login', 'primary')?.status).toBe('applied');
    const second = await target.reconcile({ requests: [request], instances: [desired] });
    expect(outcome(second, 'login', 'primary')?.status).toBe('skipped');
    expect(second.outcomes.some((entry) => entry.operation === 'start')).toBe(false);
    await target.close();
  });

  it('fails closed for untrusted plugins, missing pins, and pin mismatches', async () => {
    const target = await ChannelRuntimeAdmin.start({
      profileId: 'fixture-profile',
      composition: { ...composition(), trustedPackages: [] },
    });
    const report = await target.reconcile({ requests: [request], instances: [instance()] });
    expect(report.status).toBe('failed');
    expect(outcome(report, 'load-package')?.code).toBe('channel-plugin-untrusted');
    await target.close();

    const trusted = await admin();
    const missingPin = await trusted.reconcile({ requests: [], instances: [instance()] });
    expect(outcome(missingPin, 'load-package')?.code).toBe('channel-package-not-declared');
    const mismatched = await trusted.reconcile({
      requests: [{ package: request.package, version: '9.9.9' }],
      instances: [instance()],
    });
    expect(outcome(mismatched, 'load-package')?.code).toBe('channel-package-pin-mismatch');
    expect(mismatched.outcomes.some((entry) => entry.operation === 'start')).toBe(false);
    await trusted.close();
  });

  it('stops disabled instances, restarts on drift, and unloads unneeded packages', async () => {
    const target = await admin();
    await target.reconcile({ requests: [request], instances: [instance()] });

    const drifted = instance('primary', { config: { label: 'next' } });
    const restartReport = await target.reconcile({ requests: [request], instances: [drifted] });
    expect(outcome(restartReport, 'restart', 'primary')?.status).toBe('applied');

    const stopReport = await target.reconcile({
      requests: [request],
      instances: [instance('primary', { enabled: false })],
    });
    expect(outcome(stopReport, 'stop', 'primary')?.status).toBe('applied');
    expect(outcome(stopReport, 'unload-package')?.status).toBe('applied');
    expect(target.snapshot().loadedPlugins).toHaveLength(0);
    await target.close();
  });

  it('reconnect preserves the runtime when desired state is unchanged and fails on drift', async () => {
    const target = await admin();
    const desired = instance();
    await target.reconcile({ requests: [request], instances: [desired] });

    const unchanged = await target.reconnectInstance(desired);
    expect(unchanged).toMatchObject({ status: 'applied' });

    const drifted = await target.reconnectInstance(
      instance('primary', { configVersion: 2, config: { label: 'moved' } }),
    );
    expect(drifted).toMatchObject({ status: 'failed', code: 'channel-desired-drift' });
    expect(target.snapshot().manager.readyCount).toBe(1);
    await target.close();
  });

  it('refuses destructive interruption while work is in flight', async () => {
    const target = await admin(source(plugin({ inFlight: 2 })));
    await target.reconcile({ requests: [request], instances: [instance()] });

    const stop = await target.stopInstance(instance());
    expect(stop).toMatchObject({ status: 'failed', code: 'channel-activity-in-flight' });
    const restart = await target.restartInstance(instance());
    expect(restart).toMatchObject({ status: 'failed', code: 'channel-activity-in-flight' });
    expect(target.snapshot().manager.readyCount).toBe(1);
    await target.close();
  });

  it('a failed start cleans up its plan and the next reconcile retries cleanly', async () => {
    let failStart = true;
    const base = channelPluginPackage.channelPlugin;
    const flaky: ChannelPlugin = {
      ...base,
      async start(context): Promise<ChannelRuntime> {
        if (failStart) throw new Error('fixture start failed');
        return fakeRuntime(context);
      },
    };
    const target = await admin(source(flaky));
    const first = await target.reconcile({ requests: [request], instances: [instance()] });
    expect(outcome(first, 'start', 'primary')?.status).toBe('failed');
    expect(target.snapshot().manager.instanceCount).toBe(0);

    failStart = false;
    const second = await target.reconcile({ requests: [request], instances: [instance()] });
    expect(outcome(second, 'start', 'primary')?.status).toBe('applied');
    expect(target.snapshot().manager.readyCount).toBe(1);
    await target.close();
  });

  it('reports channel-auth-unsupported for plugins without auth hooks', async () => {
    const target = await admin(source(plugin({ withAuth: false })));
    const report = await target.reconcile({
      requests: [request],
      instances: [instance('primary', { auth: { intent: 'login', requestedAt: '2026-09-19T00:00:00.000Z' } })],
    });
    expect(outcome(report, 'login', 'primary')).toMatchObject({
      status: 'failed',
      code: 'channel-auth-unsupported',
    });
    await target.close();
  });

  it('consumes logout intent through the provider logout hook', async () => {
    const channelPlugin = plugin();
    const target = await admin(source(channelPlugin));
    const report = await target.reconcile({
      requests: [request],
      instances: [instance('primary', { auth: { intent: 'logout', requestedAt: '2026-09-19T00:00:00.000Z' } })],
    });
    expect(outcome(report, 'logout', 'primary')?.status).toBe('applied');
    await target.close();
  });
});
