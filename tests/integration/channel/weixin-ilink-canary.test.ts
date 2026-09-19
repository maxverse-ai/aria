import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeAdapterCommands,
  CHANNEL_INSTANCE_DISABLE_COMMAND,
  CHANNEL_INSTANCE_ENABLE_COMMAND,
  CHANNEL_INSTANCE_LOGIN_COMMAND,
  CHANNEL_PLUGIN_PIN_COMMAND,
  channelAuthParameters,
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
  ChannelInboundEnvelope,
  ChannelIngressAcceptance,
  ChannelPluginContext,
  ChannelRuntime,
  ResolvedChannelInstance,
} from '../../../src/channel/plugin/types';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
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
  createWeixinIlinkPlugin,
  FakeIlinkTransport,
  FileIlinkCredentialStore,
  WEIXIN_ILINK_PACKAGE_NAME,
  WEIXIN_ILINK_PACKAGE_VERSION,
  WEIXIN_ILINK_PLUGIN_ID,
  type IlinkInboundMessage,
  type WeixinIlinkConfig,
  type WeixinIlinkRuntime,
} from '../../../channel-plugins/weixin-ilink/src/index';

/**
 * Stage 11F canary evidence: one explicitly opted-in weixin-ilink account
 * exercised end to end against the no-network fake provider. Durability is
 * file-backed (stateDir), so process and host restarts share one path —
 * reopening the same state directory with a fresh runtime.
 */

const ALLOWED = 'wx-canary-user';
const INSTANCE_ID = 'wx-canary';
const PIN = { package: WEIXIN_ILINK_PACKAGE_NAME, version: WEIXIN_ILINK_PACKAGE_VERSION };
const TRUST = { ...PIN, pluginId: WEIXIN_ILINK_PLUGIN_ID };
const CONFIRMED = {
  status: 'confirmed' as const,
  botToken: 'canary-bot-token',
  ilinkBotId: 'canary-bot',
  baseurl: 'https://canary-ilink.invalid/',
};

const app = {
  id: 'cli_fixture',
  secret: { source: 'env' as const, id: 'LARK_APP_SECRET' },
  tenant: 'feishu' as const,
};

const actor: ControlActorContext = { source: 'local-cli', principal: 'weixin-ilink-canary' };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** Committed desired state for a v3 profile holding the canary instance. */
async function rootDir(): Promise<string> {
  const dir = await tempDir('aria-11f-');
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
          plugin: WEIXIN_ILINK_PLUGIN_ID,
          enabled: false,
          configVersion: 1,
          config: { allowedUserIds: [ALLOWED] },
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
        CHANNEL_PLUGIN_PIN_COMMAND,
        CHANNEL_INSTANCE_ENABLE_COMMAND,
        CHANNEL_INSTANCE_DISABLE_COMMAND,
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

/** Core-side durable sink model: first sourceMessageId wins. */
function makeIngress() {
  const seen = new Set<string>();
  const envelopes: ChannelInboundEnvelope[] = [];
  const port = {
    async accept(envelope: ChannelInboundEnvelope): Promise<ChannelIngressAcceptance> {
      if (seen.has(envelope.sourceMessageId)) {
        return { status: 'duplicate', receiptId: 'r-duplicate' };
      }
      seen.add(envelope.sourceMessageId);
      envelopes.push(envelope);
      return { status: 'accepted', receiptId: `r-${envelopes.length}` };
    },
  };
  return { seen, envelopes, port };
}

function makePlugin(transport: FakeIlinkTransport, stateDir: string) {
  return createWeixinIlinkPlugin({
    transportFor: () => transport,
    loginService: () => transport,
    stateDir,
    backoffMs: 0,
    loginPollMs: 1,
    loginTimeoutMs: 300,
  });
}

function packageSource(transport: FakeIlinkTransport, stateDir: string): ExternalChannelPluginPackageSource {
  const channelPlugin = makePlugin(transport, stateDir);
  return {
    resolve: async () => ({
      specifier: 'fixture:weixin-ilink-installed',
      metadata: { name: PIN.package, version: PIN.version },
    }),
    importModule: async () => ({ channelPluginPackage: { channelPlugin } }),
  };
}

function composition(
  transport: FakeIlinkTransport,
  stateDir: string,
  ingress: ReturnType<typeof makeIngress>,
): ExternalChannelPluginComposition {
  return {
    trustedPackages: [TRUST],
    source: packageSource(transport, stateDir),
    createIngress: () => ingress.port,
  };
}

function message(overrides: Partial<IlinkInboundMessage> = {}): IlinkInboundMessage {
  return {
    message_id: 5001,
    from_user_id: ALLOWED,
    create_time_ms: 100,
    session_id: 'canary-session',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: 'canary inbound' } }],
    context_token: 'canary-ctx',
    ...overrides,
  };
}

async function waitFor(check: () => boolean, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!check()) throw new Error('condition did not become true');
}

/** Direct package start for behaviors below the operations surface. */
async function startCanaryRuntime(
  transport: FakeIlinkTransport,
  stateDir: string,
  ingress: ReturnType<typeof makeIngress>,
): Promise<WeixinIlinkRuntime> {
  // The canary account is already logged in: seed the file credential the
  // QR flow would have written, so the runtime starts authenticated.
  await new FileIlinkCredentialStore(
    join(stateDir, INSTANCE_ID, 'credential.json'),
  ).write({
    botToken: CONFIRMED.botToken,
    ilinkBotId: CONFIRMED.ilinkBotId,
    baseurl: CONFIRMED.baseurl,
  });
  const plugin = makePlugin(transport, stateDir);
  const context: ChannelPluginContext<WeixinIlinkConfig> = {
    instance: {
      profileId: 'primary',
      pluginId: WEIXIN_ILINK_PLUGIN_ID,
      instanceId: INSTANCE_ID,
      enabled: true,
      configVersion: 1,
      config: { allowedUserIds: [ALLOWED] } as WeixinIlinkConfig,
      secretRefs: {},
    },
    ingress: ingress.port,
    signal: new AbortController().signal,
  };
  return (await plugin.start(context)) as WeixinIlinkRuntime;
}

describe('stage 11F single-account weixin-ilink canary', () => {
  it('rolls out one opted-in account through login, traffic, restart, and rollback', async () => {
    const dir = await rootDir();
    const stateDir = await tempDir('ilink-canary-state-');
    const transport = new FakeIlinkTransport();
    transport.scriptQrStatuses([{ status: 'scaned' }, CONFIRMED]);
    const ingress = makeIngress();

    // The canary is opt-in only: desired enabled:false produces nothing.
    await commit(dir, CHANNEL_PLUGIN_PIN_COMMAND, PIN);
    let admin = await ChannelRuntimeAdmin.start({
      profileId: 'primary',
      composition: composition(transport, stateDir, ingress),
    });
    let state = await desired(dir);
    let report = await admin.reconcile(state);
    expect(admin.snapshot().manager.instanceCount).toBe(0);

    // Explicit enable + a single login intent roll the account out.
    await commit(dir, CHANNEL_INSTANCE_ENABLE_COMMAND, channelInstanceIdParameters(INSTANCE_ID));
    await commit(dir, CHANNEL_INSTANCE_LOGIN_COMMAND, channelAuthParameters(INSTANCE_ID, '2026-09-20T00:00:00.000Z'));
    state = await desired(dir);
    report = await admin.reconcile(state);
    expect(report.status).toBe('applied');
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'login', instanceId: INSTANCE_ID, status: 'applied' }),
    );
    expect(transport.qrSessionCount).toBe(1);

    // Traffic flows in both directions.
    transport.push([message()]);
    await waitFor(() => ingress.envelopes.length === 1);

    // Process/host restart: a fresh admin + plugin over the same stateDir
    // resumes credential, cursor, and ledger — no QR round, no redelivery.
    await admin.close();
    admin = await ChannelRuntimeAdmin.start({
      profileId: 'primary',
      composition: composition(transport, stateDir, ingress),
    });
    report = await admin.reconcile(await desired(dir));
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'start', instanceId: INSTANCE_ID, status: 'applied' }),
    );
    expect(transport.qrSessionCount).toBe(1);
    transport.push([message({ message_id: 5002 })]);
    await waitFor(() => ingress.envelopes.length === 2);
    expect(ingress.envelopes.map((envelope) => envelope.sourceMessageId)).toEqual([
      'ilink:5001',
      'ilink:5002',
    ]);

    // Hard rollback: disable drains/stops the account and unloads the package.
    await commit(dir, CHANNEL_INSTANCE_DISABLE_COMMAND, channelInstanceIdParameters(INSTANCE_ID));
    report = await admin.reconcile(await desired(dir));
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'stop', instanceId: INSTANCE_ID, status: 'applied' }),
    );
    expect(admin.snapshot().loadedPlugins).toHaveLength(0);
    await admin.close();
  });

  it('recovers through reauthentication on a fresh login intent', async () => {
    const dir = await rootDir();
    const stateDir = await tempDir('ilink-canary-state-');
    const transport = new FakeIlinkTransport();
    transport.scriptQrStatuses([CONFIRMED]);
    const ingress = makeIngress();

    await commit(dir, CHANNEL_PLUGIN_PIN_COMMAND, PIN);
    await commit(dir, CHANNEL_INSTANCE_ENABLE_COMMAND, channelInstanceIdParameters(INSTANCE_ID));
    await commit(dir, CHANNEL_INSTANCE_LOGIN_COMMAND, channelAuthParameters(INSTANCE_ID, '2026-09-20T00:00:00.000Z'));
    const admin = await ChannelRuntimeAdmin.start({
      profileId: 'primary',
      composition: composition(transport, stateDir, ingress),
    });
    let report = await admin.reconcile(await desired(dir));
    expect(report.status).toBe('applied');

    // Stale bearer (-14): the runtime fails closed into reauth-required and
    // stops polling until a new login intent lands.
    transport.failNextPoll(transport.authFailure());
    const status = getChannelStatus({
      profileId: 'primary',
      instances: (await desired(dir)).instances,
      declaredPackages: PIN ? [PIN] : [],
      runtime: { external: admin.snapshot() },
    });
    await waitFor(() =>
      status.instances.some(
        (entry) => entry.instanceId === INSTANCE_ID && entry.state === 'reauth-required',
      ),
    );
    const pollsAtFailure = transport.pollCount;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(transport.pollCount).toBe(pollsAtFailure);

    // A new login intent re-runs QR auth and resumes polling.
    await commit(dir, CHANNEL_INSTANCE_LOGIN_COMMAND, channelAuthParameters(INSTANCE_ID, '2026-09-20T00:05:00.000Z'));
    report = await admin.reconcile(await desired(dir));
    expect(report.outcomes).toContainEqual(
      expect.objectContaining({ operation: 'login', instanceId: INSTANCE_ID, status: 'applied' }),
    );
    transport.push([message({ message_id: 6001 })]);
    await waitFor(() => ingress.envelopes.length === 1);
    await admin.close();
  });

  it('suppresses duplicate input at both the runtime and the durable sink', async () => {
    const stateDir = await tempDir('ilink-canary-state-');
    const transport = new FakeIlinkTransport();
    const ingress = makeIngress();
    const runtime = await startCanaryRuntime(transport, stateDir, ingress);
    try {
      transport.push([message()]);
      await waitFor(() => ingress.envelopes.length === 1);
      await waitFor(() => transport.typing.length === 1);

      // Provider redelivers the same message despite the advanced cursor:
      // the sink reports duplicate, nothing is reprocessed or re-typed.
      transport.push([message()]);
      await waitFor(() => transport.pollCount > 3);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(ingress.envelopes).toHaveLength(1);
      expect(transport.typing).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('recovers a partial delivery without double-sending completed intents', async () => {
    const stateDir = await tempDir('ilink-canary-state-');
    const transport = new FakeIlinkTransport();
    const ingress = makeIngress();
    const runtime = await startCanaryRuntime(transport, stateDir, ingress);
    const inst = runtime.instance;
    const intent = (deliveryId: string) => ({
      abiVersion: 1 as const,
      profileId: inst.profileId,
      pluginId: inst.pluginId,
      instanceId: inst.instanceId,
      deliveryId,
      sourceMessageId: 'ilink:5001',
      scopeId: 'canary-session',
      content: { kind: 'text' as const, text: `reply ${deliveryId}` },
      replyContext: { ilink: { contextToken: 'canary-ctx', userId: ALLOWED } },
    });
    try {
      const first = await runtime.deliver(intent('d-1'));
      transport.failNextSend(
        new ChannelPluginError('provider busy', {
          kind: 'transient',
          code: 'weixin-ilink-transport',
        }),
      );
      await expect(runtime.deliver(intent('d-2'))).rejects.toMatchObject({
        code: 'weixin-ilink-transport',
      });
      // The failed intent retries and lands; the completed one replays from
      // the ledger without another provider send.
      const second = await runtime.deliver(intent('d-2'));
      expect(second.status).toBe('sent');
      expect(await runtime.deliver(intent('d-1'))).toEqual(first);
      expect(transport.sent).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it('survives provider rate limiting without losing the poll loop', async () => {
    const stateDir = await tempDir('ilink-canary-state-');
    const transport = new FakeIlinkTransport();
    const ingress = makeIngress();
    const runtime = await startCanaryRuntime(transport, stateDir, ingress);
    try {
      transport.failNextPoll(
        new ChannelPluginError('rate limited', {
          kind: 'transient',
          code: 'weixin-ilink-transport',
        }),
      );
      await waitFor(() => transport.pollCount >= 3);
      expect(runtime.snapshot().state).toBe('ready');
      transport.push([message()]);
      await waitFor(() => ingress.envelopes.length === 1);
    } finally {
      await runtime.close();
    }
  });

  it('drains bounded in-flight work and reports what remains', async () => {
    const stateDir = await tempDir('ilink-canary-state-');
    const transport = new FakeIlinkTransport();
    const ingress = makeIngress();
    const runtime = await startCanaryRuntime(transport, stateDir, ingress);
    const inst = runtime.instance;
    try {
      transport.holdNextSend();
      const pending = runtime.deliver({
        abiVersion: 1,
        profileId: inst.profileId,
        pluginId: inst.pluginId,
        instanceId: inst.instanceId,
        deliveryId: 'd-hold',
        scopeId: 'canary-session',
        content: { kind: 'text', text: 'held reply' },
        replyContext: { ilink: { contextToken: 'canary-ctx', userId: ALLOWED } },
      });
      await waitFor(() => runtime.snapshot().inFlightOutbound === 1);
      const result = await runtime.drain({ deadlineAt: Date.now() + 60 });
      expect(result.drained).toBe(false);
      expect(result.remainingOutbound).toBe(1);
      transport.releaseSends();
      await pending;
    } finally {
      await runtime.close();
    }
  });

  it('keeps weixin-ilink disabled by default and absent from stock profiles', async () => {
    const stock = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    const projected = [
      ...projectProfileChannelInstances({ profileId: 'primary', profile: stock }),
    ];
    expect(projected.every((entry) => entry.pluginId !== WEIXIN_ILINK_PLUGIN_ID)).toBe(true);

    // Enabled desired state is still inert without an explicit pin + trust.
    const dir = await rootDir();
    await commit(dir, CHANNEL_INSTANCE_ENABLE_COMMAND, channelInstanceIdParameters(INSTANCE_ID));
    const admin = await ChannelRuntimeAdmin.start({
      profileId: 'primary',
      composition: composition(new FakeIlinkTransport(), await tempDir('ilink-canary-state-'), makeIngress()),
    });
    const report = await admin.reconcile(await desired(dir));
    expect(
      report.outcomes.some(
        (outcome) => outcome.instanceId === INSTANCE_ID && outcome.status === 'applied' && outcome.operation === 'start',
      ),
    ).toBe(false);
    expect(admin.snapshot().manager.instanceCount).toBe(0);
    await admin.close();
  });
});
