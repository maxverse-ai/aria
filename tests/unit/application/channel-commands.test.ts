import { describe, expect, it } from 'vitest';
import {
  channelAuthParameters,
  channelInstanceConfigureCommand,
  channelInstanceConfigureParameters,
  channelInstanceDisableCommand,
  channelInstanceEnableCommand,
  channelInstanceIdParameters,
  channelInstanceLoginCommand,
  channelInstanceLogoutCommand,
  channelPluginPinCommand,
} from '../../../src/application/control/channel-commands';
import { ControlChangeError } from '../../../src/application/control/change-types';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
  type ProfileConfig,
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
  secretRefs: { bearer: { source: 'file', id: 'weixin/bearer' } },
};

function v3Profile(instances: Record<string, unknown> = {}, plugins: unknown[] = []): ProfileConfig {
  return normalizeProfileConfig({
    ...createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
    schemaVersion: 3,
    channels: { plugins, instances: { 'lark-primary': larkPrimary, ...instances } },
  });
}

function rootWith(profile: ProfileConfig, name = 'work'): RootConfig {
  return { schemaVersion: 3, activeProfile: name, preferences: {}, profiles: { [name]: profile } };
}

function prepare(command: { prepare: Function }, root: RootConfig, parameters: Record<string, unknown>) {
  return command.prepare({ root, profile: 'work', parameters: parameters as never });
}

describe('channel.plugin.pin', () => {
  it('pins a package and later updates the pin in place', () => {
    const root = rootWith(v3Profile());
    const first = prepare(channelPluginPinCommand, root, {
      package: '@acme/aria-channel-weixin-ilink',
      version: '0.1.0',
    });
    expect(first.root.profiles.work!.channels!.plugins).toEqual([
      { package: '@acme/aria-channel-weixin-ilink', version: '0.1.0' },
    ]);
    const second = prepare(channelPluginPinCommand, first.root, {
      package: '@acme/aria-channel-weixin-ilink',
      version: '0.2.0',
    });
    expect(second.root.profiles.work!.channels!.plugins).toEqual([
      { package: '@acme/aria-channel-weixin-ilink', version: '0.2.0' },
    ]);
    expect(second.changes[0]).toMatchObject({ before: '0.1.0', after: '0.2.0' });
  });

  it('rejects an identical pin and invalid package identities', () => {
    const root = rootWith(v3Profile({}, [{ package: '@acme/pkg', version: '1.0.0' }]));
    expect(() =>
      prepare(channelPluginPinCommand, root, { package: '@acme/pkg', version: '1.0.0' }),
    ).toThrow(/already pinned/);
    expect(() =>
      prepare(channelPluginPinCommand, root, { package: 'Not A Package', version: '1.0.0' }),
    ).toThrow();
    expect(() =>
      prepare(channelPluginPinCommand, root, { package: '@acme/pkg', version: 'latest' }),
    ).toThrow();
  });
});

describe('channel.instance.configure', () => {
  const parameters = channelInstanceConfigureParameters({
    instanceId: 'personal-1',
    pluginId: 'weixin-ilink',
    configVersion: 1,
    config: { mode: 'qr', region: 'cn' },
    secretRefs: { bearer: { source: 'file', id: 'weixin/bearer' } },
  });

  it('creates a disabled external instance with validated config and secret refs', () => {
    const root = rootWith(v3Profile());
    const { root: next, changes } = prepare(channelInstanceConfigureCommand, root, parameters);
    const stored = next.profiles.work!.channels!.instances['personal-1'];
    expect(stored).toMatchObject({
      plugin: 'weixin-ilink',
      enabled: false,
      configVersion: 1,
      config: { mode: 'qr', region: 'cn' },
    });
    expect(changes.map((change: { field: string }) => change.field)).toEqual([
      'channels.instances.personal-1.plugin',
      'channels.instances.personal-1.configVersion',
      'channels.instances.personal-1.refCount',
    ]);
    expect(() => normalizeProfileConfig(next.profiles.work!)).not.toThrow();
  });

  it('reconfigures in place while preserving enabled and auth intent', () => {
    const root = rootWith(
      v3Profile({
        'personal-1': { ...externalInstance, enabled: true, auth: { intent: 'login', requestedAt: '2026-09-19T00:00:00Z' } },
      }),
    );
    const { root: next } = prepare(channelInstanceConfigureCommand, root, {
      ...parameters,
      configJson: JSON.stringify({ mode: 'token' }),
      configVersion: 2,
    });
    const stored = next.profiles.work!.channels!.instances['personal-1'];
    expect(stored).toMatchObject({
      enabled: true,
      configVersion: 2,
      config: { mode: 'token' },
      auth: { intent: 'login', requestedAt: '2026-09-19T00:00:00Z' },
    });
  });

  it('rejects plugin swaps, the protected lark binding, and malformed payloads', () => {
    const root = rootWith(v3Profile({ 'personal-1': externalInstance }));
    expect(() =>
      prepare(channelInstanceConfigureCommand, root, { ...parameters, pluginId: 'other-plugin' }),
    ).toThrow(/plugin cannot change/);
    expect(() =>
      prepare(channelInstanceConfigureCommand, root, { ...parameters, instanceId: 'lark-primary', pluginId: 'lark' }),
    ).toThrow(/lark-primary/);
    expect(() =>
      prepare(channelInstanceConfigureCommand, root, { ...parameters, configJson: 'not-json' }),
    ).toThrow(/valid JSON/);
    expect(() =>
      prepare(channelInstanceConfigureCommand, root, {
        ...parameters,
        refMapJson: JSON.stringify({ bearer: { source: 'inline', id: 'x' } }),
      }),
    ).toThrow(/failed validation/);
  });
});

describe('channel.instance.enable / disable', () => {
  it('flips enabled and rejects no-ops and missing instances', () => {
    const root = rootWith(v3Profile({ 'personal-1': externalInstance }));
    const { root: enabled } = prepare(channelInstanceEnableCommand, root, channelInstanceIdParameters('personal-1'));
    expect(enabled.profiles.work!.channels!.instances['personal-1']!.enabled).toBe(true);
    const { root: disabled } = prepare(channelInstanceDisableCommand, enabled, channelInstanceIdParameters('personal-1'));
    expect(disabled.profiles.work!.channels!.instances['personal-1']!.enabled).toBe(false);
    expect(() =>
      prepare(channelInstanceDisableCommand, disabled, channelInstanceIdParameters('personal-1')),
    ).toThrow(/already disabled/);
    expect(() =>
      prepare(channelInstanceEnableCommand, root, channelInstanceIdParameters('ghost')),
    ).toThrow(/does not exist/);
    expect(() =>
      prepare(channelInstanceDisableCommand, root, channelInstanceIdParameters('lark-primary')),
    ).toThrow(/lark-primary/);
  });
});

describe('channel.instance.login / logout', () => {
  it('records a provider-neutral auth intent without touching credentials', () => {
    const root = rootWith(v3Profile({ 'personal-1': { ...externalInstance, enabled: true } }));
    const { root: next, changes } = prepare(
      channelInstanceLoginCommand,
      root,
      channelAuthParameters('personal-1', '2026-09-19T12:00:00Z'),
    );
    const stored = next.profiles.work!.channels!.instances['personal-1']!;
    expect(stored.auth).toEqual({ intent: 'login', requestedAt: '2026-09-19T12:00:00Z' });
    expect(changes[0]).toMatchObject({ before: null, after: 'login' });
    expect(JSON.stringify(changes)).not.toContain('weixin/bearer');
    expect(() => normalizeProfileConfig(next.profiles.work!)).not.toThrow();
  });

  it('rejects login for disabled instances, built-ins, and repeated intents', () => {
    const disabled = rootWith(v3Profile({ 'personal-1': externalInstance }));
    expect(() =>
      prepare(channelInstanceLoginCommand, disabled, channelAuthParameters('personal-1', 't')),
    ).toThrow(/disabled/);
    const builtIn = rootWith(v3Profile({ kf: { ...externalInstance, plugin: 'wechat-kf', enabled: true } }));
    expect(() =>
      prepare(channelInstanceLoginCommand, builtIn, channelAuthParameters('kf', 't')),
    ).toThrow(/external channel plugins/);
    const loggedIn = rootWith(
      v3Profile({ 'personal-1': { ...externalInstance, enabled: true, auth: { intent: 'login', requestedAt: 't0' } } }),
    );
    expect(() =>
      prepare(channelInstanceLoginCommand, loggedIn, channelAuthParameters('personal-1', 't1')),
    ).toThrow(/already holds a login intent/);
    const { root: loggedOut } = prepare(
      channelInstanceLogoutCommand,
      loggedIn,
      channelAuthParameters('personal-1', 't2'),
    );
    expect(loggedOut.profiles.work!.channels!.instances['personal-1']!.auth).toEqual({
      intent: 'logout',
      requestedAt: 't2',
    });
  });
});

describe('schema gating', () => {
  it('rejects channel commands against schema v2 profiles byte-for-byte', () => {
    const v2 = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    const root = rootWith(v2);
    for (const command of [
      channelPluginPinCommand,
      channelInstanceConfigureCommand,
      channelInstanceEnableCommand,
      channelInstanceLoginCommand,
    ]) {
      expect(() =>
        command.prepare({
          root,
          profile: 'work',
          parameters: {
            instanceId: 'personal-1',
            pluginId: 'weixin-ilink',
            configVersion: 1,
            configJson: '{}',
            refMapJson: '{}',
            package: '@acme/pkg',
            version: '1.0.0',
            requestedAt: 't',
          },
        }),
      ).toThrow(ControlChangeError);
    }
  });
});
