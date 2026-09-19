import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runChannelDiagnose,
  runChannelEnable,
  runChannelList,
  runChannelLogin,
  runChannelPin,
  runChannelStatus,
} from '../../../src/cli/commands/channel';
import {
  runConfigApply,
  runConfigConfirm,
} from '../../../src/cli/commands/config-change';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  loadRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';

const app = {
  id: 'cli_channels',
  secret: { source: 'env' as const, id: 'LARK_APP_SECRET' },
  tenant: 'feishu' as const,
};

const larkPrimary = {
  plugin: 'lark',
  enabled: true,
  configVersion: 1,
  config: { appId: app.id, tenant: app.tenant, credentialMode: 'secret-ref' },
  secretRefs: { appSecret: app.secret },
};

const externalInstance = {
  plugin: 'weixin-ilink',
  enabled: false,
  configVersion: 1,
  config: { mode: 'qr' },
  secretRefs: { bearer: { source: 'file' as const, id: 'weixin/bearer' } },
};

const roots: string[] = [];
const output: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function capture(): void {
  output.length = 0;
  vi.spyOn(console, 'log').mockImplementation((line) => output.push(String(line)));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

async function fixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-channel-cli-'));
  roots.push(rootDir);
  const profile = normalizeProfileConfig({
    ...createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
    schemaVersion: 3,
    channels: {
      plugins: [],
      instances: { 'lark-primary': larkPrimary, 'weixin-main': externalInstance },
    },
  });
  const root: RootConfig = {
    schemaVersion: 3,
    activeProfile: 'primary',
    preferences: {},
    profiles: { primary: profile },
  };
  await saveRootConfig(root, resolveAppPaths({ rootDir, profile: 'primary' }).configFile);
  await writeActiveProfile(rootDir, 'primary');
  return rootDir;
}

describe('channel CLI handlers', () => {
  it('lists resolved instances without leaking config or secrets', async () => {
    const rootDir = await fixture();
    capture();
    await runChannelList({ rootDir, profile: 'primary', json: true });
    const rows = JSON.parse(output.pop()!);
    expect(rows.map((row: { instanceId: string }) => row.instanceId).sort()).toEqual([
      'lark-primary',
      'weixin-main',
    ]);
    const weixin = rows.find((row: { instanceId: string }) => row.instanceId === 'weixin-main');
    expect(weixin).toMatchObject({ pluginId: 'weixin-ilink', state: 'inactive' });
    expect(JSON.stringify(rows)).not.toContain('weixin/bearer');
  });

  it('prints status and diagnostics over the same read model', async () => {
    const rootDir = await fixture();
    capture();
    await runChannelStatus({ rootDir, profile: 'primary', json: true });
    const status = JSON.parse(output.pop()!);
    expect(status).toMatchObject({ schema: 'aria.channel.status.v1', profileId: 'primary' });
    await runChannelDiagnose({ rootDir, profile: 'primary', json: true });
    expect(JSON.parse(output.pop()!)).toBeInstanceOf(Array);
  });

  it('pins a package through the shared plan store', async () => {
    const rootDir = await fixture();
    capture();
    await runChannelPin('@acme/aria-channel-weixin-ilink', '0.1.0', {
      rootDir,
      profile: 'primary',
      json: true,
    });
    const plan = JSON.parse(output.pop()!);
    expect(plan.operation.id).toBe('channel.plugin.pin');

    await runConfigConfirm(plan.id, { rootDir, json: true });
    await runConfigApply(plan.id, { rootDir, json: true });
    const root = await loadRootConfig(join(rootDir, 'config.json'));
    expect(root?.profiles.primary?.channels?.plugins).toEqual([
      { package: '@acme/aria-channel-weixin-ilink', version: '0.1.0' },
    ]);
  });

  it('enables a disabled external instance through plan/confirm/apply', async () => {
    const rootDir = await fixture();
    capture();
    await runChannelEnable('weixin-main', { rootDir, profile: 'primary', json: true });
    const plan = JSON.parse(output.pop()!);
    expect(plan.operation.id).toBe('channel.instance.enable');

    await runConfigConfirm(plan.id, { rootDir, json: true });
    await runConfigApply(plan.id, { rootDir, json: true });
    const root = await loadRootConfig(join(rootDir, 'config.json'));
    expect(root?.profiles.primary?.channels?.instances['weixin-main']?.enabled).toBe(true);
  });

  it('records a login intent through plan/confirm/apply', async () => {
    const rootDir = await fixture();
    capture();
    await runChannelEnable('weixin-main', { rootDir, profile: 'primary', json: true });
    const enablePlan = JSON.parse(output.pop()!);
    await runConfigConfirm(enablePlan.id, { rootDir, json: true });
    await runConfigApply(enablePlan.id, { rootDir, json: true });

    await runChannelLogin('weixin-main', { rootDir, profile: 'primary', json: true });
    const plan = JSON.parse(output.pop()!);
    expect(plan.operation.id).toBe('channel.instance.login');

    await runConfigConfirm(plan.id, { rootDir, json: true });
    await runConfigApply(plan.id, { rootDir, json: true });
    const root = await loadRootConfig(join(rootDir, 'config.json'));
    expect(root?.profiles.primary?.channels?.instances['weixin-main']?.auth).toMatchObject({
      intent: 'login',
    });
  });
});
