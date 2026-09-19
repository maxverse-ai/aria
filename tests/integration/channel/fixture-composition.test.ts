import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeAdapterCommands,
  CHANNEL_INSTANCE_CONFIGURE_COMMAND,
  CHANNEL_INSTANCE_DISABLE_COMMAND,
  CHANNEL_INSTANCE_ENABLE_COMMAND,
  CHANNEL_INSTANCE_LOGIN_COMMAND,
  CHANNEL_PLUGIN_PIN_COMMAND,
  channelAuthParameters,
  channelInstanceConfigureParameters,
  channelInstanceIdParameters,
  ConfigChangeService,
  getChannelStatus,
  MANAGEMENT_API_VERSION,
  ManagementApi,
  managementCommandRegistry,
  type ControlActorContext,
  type ControlPlanParameters,
} from '../../../src/application/control';
import { ChannelRuntimeAdmin } from '../../../src/runtime/channel-runtime-admin';
import type { ExternalChannelPluginComposition } from '../../../src/runtime/external-channel-runtime';
import type { ExternalChannelPluginPackageSource } from '../../../src/channel/plugin/loader';
import type {
  ChannelPlugin,
  ChannelRuntime,
  ChannelRuntimeSnapshot,
  ResolvedChannelInstance,
} from '../../../src/channel/plugin/types';
import { projectProfileChannelInstances } from '../../../src/channel/instance-resolver';
import { migrateRootConfigToSchemaV3 } from '../../../src/config/channel-schema-migration';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  channelPluginPackage,
  NOOP_EXTERNAL_CHANNEL_PACKAGE,
  NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
  NOOP_EXTERNAL_CHANNEL_VERSION,
} from '../../fixtures/channel/noop-external-channel-plugin';

const app = {
  id: 'cli_fixture',
  secret: { source: 'env' as const, id: 'LARK_APP_SECRET' },
  tenant: 'feishu' as const,
};

const PIN = { package: NOOP_EXTERNAL_CHANNEL_PACKAGE, version: NOOP_EXTERNAL_CHANNEL_VERSION };
const TRUST = { ...PIN, pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID };
const INSTANCE_ID = 'fixture-main';

const actor: ControlActorContext = { source: 'local-cli', principal: 'fixture-composition' };

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A no-network fixture runtime with spied auth hooks and configurable behavior. */
function fixtureRuntime(
  context: { instance: ResolvedChannelInstance },
  behavior: { inFlight?: number; withAuth?: boolean } = {},
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
      providerMessageId: `fixture:${intent.deliveryId}`,
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

function fixturePlugin(behavior: { failStart?: boolean; withAuth?: boolean } = {}): ChannelPlugin {
  const base = channelPluginPackage.channelPlugin;
  return {
    ...base,
    async start(context): Promise<ChannelRuntime> {
      if (behavior.failStart) throw new Error('fixture start failed');
      return fixtureRuntime(context, behavior);
    },
  };
}

function packageSource(channelPlugin: ChannelPlugin = fixturePlugin()) {
  const value: ExternalChannelPluginPackageSource & {
    resolve: ReturnType<typeof vi.fn>;
    importModule: ReturnType<typeof vi.fn>;
  } = {
    resolve: vi.fn(async () => ({
      specifier: 'fixture:installed-package',
      metadata: { name: PIN.package, version: PIN.version },
    })),
    importModule: vi.fn(async () => ({ channelPluginPackage: { channelPlugin } })),
  };
  return value;
}

/** Explicit downstream composition: trust is deployment-owned, never desired state. */
function composition(source = packageSource()): ExternalChannelPluginComposition {
  return {
    trustedPackages: [TRUST],
    source,
    createIngress: () => ({
      accept: async () => ({ status: 'accepted', receiptId: 'fixture-receipt' }),
    }),
  };
}

/** Committed desired state for a v3 profile with a disabled external instance. */
async function rootDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aria-channel-10f-'));
  roots.push(dir);
  const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
  const root = migrateRootConfigToSchemaV3(createRootConfig('primary', profile));
  const stored = root.profiles.primary!;
  root.profiles.primary = {
    ...stored,
    channels: {
      ...stored.channels!,
      instances: {
        ...stored.channels!.instances,
        [INSTANCE_ID]: {
          plugin: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
          enabled: false,
          configVersion: 1,
          config: { label: INSTANCE_ID },
          secretRefs: {},
        },
      },
    },
  };
  await saveRootConfig(root, resolveAppPaths({ rootDir: dir, profile: 'primary' }).configFile);
  return dir;
}

function api(dir: string): ManagementApi {
  return new ManagementApi(
    new ConfigChangeService({
      rootDir: dir,
      registry: managementCommandRegistry,
      authorizeCommand: authorizeAdapterCommands('local-cli', [
        CHANNEL_INSTANCE_CONFIGURE_COMMAND,
        CHANNEL_INSTANCE_ENABLE_COMMAND,
        CHANNEL_INSTANCE_LOGIN_COMMAND,
      ]),
    }),
  );
}

async function commit(dir: string, command: string, input: ControlPlanParameters): Promise<void> {
  const management = api(dir);
  const { plan } = await management.plan({
    schema: 'aria.management.plan.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    profile: 'primary',
    command,
    input,
    actor,
  });
  await management.confirm({
    schema: 'aria.management.confirm.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    planId: plan.id,
    actor,
  });
  await management.commit({
    schema: 'aria.management.commit.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    planId: plan.id,
    actor,
  });
}

async function desired(dir: string): Promise<{
  requests: { package: string; version: string }[];
  instances: ResolvedChannelInstance[];
}> {
  const root = await loadRootConfig(join(dir, 'config.json'));
  const profile = root?.profiles.primary;
  if (!profile) throw new Error('profile missing');
  return {
    requests: [...(profile.channels?.plugins ?? [])],
    instances: [...projectProfileChannelInstances({ profileId: 'primary', profile })],
  };
}

describe('stage 10F fixture composition end to end', () => {
  it('runs pin → configure → enable → login → status → restart → disable → rollback through the operations surface', async () => {
    const dir = await rootDir();
    const source = packageSource();
    const admin = await ChannelRuntimeAdmin.start({
      profileId: 'primary',
      composition: composition(source),
    });

    // Desired enabled alone never activates: no composition supplied anywhere yet.
    let state = await desired(dir);
    let report = await admin.reconcile(state);
    expect(report.outcomes.some((outcome) => outcome.status === 'failed' && outcome.code === 'channel-package-not-declared')).toBe(false);
    expect(admin.snapshot().manager.instanceCount).toBe(0);

    // pin + configure + enable + login intent via the plan/confirm/commit kernel.
    await commit(dir, CHANNEL_PLUGIN_PIN_COMMAND, PIN);
    await commit(dir, CHANNEL_INSTANCE_ENABLE_COMMAND, channelInstanceIdParameters(INSTANCE_ID));
    await commit(dir, CHANNEL_INSTANCE_LOGIN_COMMAND, channelAuthParameters(INSTANCE_ID, '2026-09-19T00:00:00.000Z'));

    state = await desired(dir);
    report = await admin.reconcile(state);
    expect(report.status).toBe('applied');
    // The built-in lark-primary instance stays owned by its own runtime;
    // external reconciliation never touches it.
    expect(
      report.outcomes.every((outcome) => outcome.instanceId !== 'lark-primary'),
    ).toBe(true);
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'load-package', status: 'applied' }),
    );
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'start', instanceId: INSTANCE_ID, status: 'applied' }),
    );
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'login', instanceId: INSTANCE_ID, status: 'applied' }),
    );

    // Canonical read model sees the live runtime as ready.
    const status = getChannelStatus({
      profileId: 'primary',
      instances: state.instances,
      declaredPackages: (await desired(dir)).requests,
      runtime: { external: admin.snapshot() },
    });
    const row = status.instances.find((entry) => entry.instanceId === INSTANCE_ID);
    expect(row).toMatchObject({ state: 'ready', pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID });
    expect(status.plugins).toContainEqual(
      expect.objectContaining({ package: PIN.package, declared: true, loaded: true }),
    );

    // Config drift restarts the instance transactionally.
    await commit(
      dir,
      CHANNEL_INSTANCE_CONFIGURE_COMMAND,
      channelInstanceConfigureParameters({
        instanceId: INSTANCE_ID,
        pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
        configVersion: 1,
        config: { label: 'fixture-next' },
        secretRefs: {},
      }),
    );
    state = await desired(dir);
    report = await admin.reconcile(state);
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'restart', instanceId: INSTANCE_ID, status: 'applied' }),
    );

    // Disable stops the instance and unloads the now-unneeded package.
    await commit(dir, CHANNEL_INSTANCE_DISABLE_COMMAND, channelInstanceIdParameters(INSTANCE_ID));
    state = await desired(dir);
    report = await admin.reconcile(state);
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'stop', instanceId: INSTANCE_ID, status: 'applied' }),
    );
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'unload-package', status: 'applied' }),
    );
    expect(admin.snapshot().loadedPlugins).toHaveLength(0);

    // Rollback: restoring the previous enabled desired state restarts the owner.
    await commit(dir, CHANNEL_INSTANCE_ENABLE_COMMAND, channelInstanceIdParameters(INSTANCE_ID));
    state = await desired(dir);
    report = await admin.reconcile(state);
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'start', instanceId: INSTANCE_ID, status: 'applied' }),
    );
    await admin.close();
  });

  it('fails closed on missing trust, pin mismatch, invalid config, and start failure', async () => {
    const dir = await rootDir();
    await commit(dir, CHANNEL_PLUGIN_PIN_COMMAND, PIN);
    await commit(dir, CHANNEL_INSTANCE_ENABLE_COMMAND, channelInstanceIdParameters(INSTANCE_ID));

    // Missing deployment trust: declared+enabled is not enough.
    const untrusted = await ChannelRuntimeAdmin.start({
      profileId: 'primary',
      composition: { ...composition(), trustedPackages: [] },
    });
    let state = await desired(dir);
    let report = await untrusted.reconcile(state);
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'load-package', status: 'failed', code: 'channel-plugin-untrusted' }),
    );
    expect(untrusted.snapshot().manager.instanceCount).toBe(0);
    await untrusted.close();

    // Pin that drifts from the trusted version is rejected before loading.
    const mismatched = await ChannelRuntimeAdmin.start({
      profileId: 'primary',
      composition: { ...composition(), trustedPackages: [{ ...TRUST, version: '9.9.9' }] },
    });
    report = await mismatched.reconcile(state);
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'load-package', status: 'failed', code: 'channel-package-pin-mismatch' }),
    );
    await mismatched.close();

    // Desired state is provider-schema-agnostic: an incompatible config
    // commits structurally, then fails closed at package load before any
    // runtime is created.
    await commit(
      dir,
      CHANNEL_INSTANCE_CONFIGURE_COMMAND,
      channelInstanceConfigureParameters({
        instanceId: INSTANCE_ID,
        pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
        configVersion: 1,
        config: { wrong: 'shape' },
        secretRefs: {},
      }),
    );
    state = await desired(dir);
    const misconfigured = await ChannelRuntimeAdmin.start({
      profileId: 'primary',
      composition: composition(),
    });
    report = await misconfigured.reconcile(state);
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({
        operation: 'load-package',
        status: 'failed',
        code: 'invalid-channel-plugin-config',
      }),
    );
    expect(misconfigured.snapshot().manager.instanceCount).toBe(0);
    await misconfigured.close();

    // Restore a valid config before exercising lifecycle start failure.
    await commit(
      dir,
      CHANNEL_INSTANCE_CONFIGURE_COMMAND,
      channelInstanceConfigureParameters({
        instanceId: INSTANCE_ID,
        pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
        configVersion: 1,
        config: { label: INSTANCE_ID },
        secretRefs: {},
      }),
    );
    state = await desired(dir);

    // A lifecycle start failure cleans up; retrying converges without residue.
    let failStart = true;
    const base = channelPluginPackage.channelPlugin;
    const flaky: ChannelPlugin = {
      ...base,
      async start(context): Promise<ChannelRuntime> {
        if (failStart) throw new Error('fixture start failed');
        return fixtureRuntime(context);
      },
    };
    const admin = await ChannelRuntimeAdmin.start({
      profileId: 'primary',
      composition: composition(packageSource(flaky)),
    });
    report = await admin.reconcile(state);
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'start', instanceId: INSTANCE_ID, status: 'failed' }),
    );
    expect(admin.snapshot().manager.instanceCount).toBe(0);
    failStart = false;
    report = await admin.reconcile(state);
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'start', instanceId: INSTANCE_ID, status: 'applied' }),
    );
    await admin.close();
  });
});
