import { describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
} from '../../../src/config/profile-schema';

const app = {
  id: 'cli_schema_v3',
  secret: { source: 'env' as const, id: 'LARK_APP_SECRET' },
  tenant: 'feishu' as const,
};

function v3(channels: unknown) {
  return normalizeProfileConfig({
    ...createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      plugins: ['engine-only-package'],
    }),
    schemaVersion: 3,
    channels,
  });
}

describe('profile schema v3 channels', () => {
  it('keeps engine packages separate from validated channel packages and instances', () => {
    const profile = v3({
      plugins: [{ package: '@maxverse-ai/channel-fixture', version: '1.2.3' }],
      instances: {
        'personal-primary': {
          plugin: 'weixin-ilink',
          enabled: false,
          configVersion: 1,
          config: { mode: 'qr' },
          secretRefs: { bearer: { source: 'file', id: 'weixin/bearer' } },
        },
        'lark-primary': {
          plugin: 'lark',
          enabled: true,
          configVersion: 1,
          config: {
            appId: app.id,
            tenant: app.tenant,
            credentialMode: 'secret-ref',
          },
          secretRefs: { appSecret: app.secret },
        },
      },
    });

    expect(profile.schemaVersion).toBe(3);
    expect(profile.plugins).toEqual(['engine-only-package']);
    expect(profile.channels?.plugins).toEqual([
      { package: '@maxverse-ai/channel-fixture', version: '1.2.3' },
    ]);
    expect(Object.keys(profile.channels?.instances ?? {})).toEqual([
      'lark-primary',
      'personal-primary',
    ]);
    expect(Object.isFrozen(profile.channels)).toBe(true);
    expect(JSON.stringify(profile.channels)).not.toContain('engine-only-package');
  });

  it('rejects channel records in schema v2 instead of silently dropping them', () => {
    expect(() => normalizeProfileConfig({
      ...createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
      channels: { plugins: [], instances: {} },
    })).toThrow(/schemaVersion 2 cannot declare channels/);
  });

  it('rejects duplicate package declarations and reserved plugin aliases', () => {
    expect(() => v3({
      plugins: [
        { package: 'channel-fixture', version: '1.0.0' },
        { package: 'channel-fixture', version: '1.0.1' },
      ],
      instances: {},
    })).toThrow(/duplicate channel plugin package/);

    expect(() => v3({
      plugins: [],
      instances: {
        bad: {
          plugin: 'wxkf',
          enabled: false,
          configVersion: 1,
          config: {},
          secretRefs: {},
        },
      },
    })).toThrow(/invalid canonical channel plugin id/);
  });

  it('requires exact semver channel package pins', () => {
    for (const version of ['latest', '^1.2.3', '~1.2.3', 'workspace:*']) {
      expect(() => v3({
        plugins: [{ package: '@maxverse-ai/channel-fixture', version }],
        instances: {},
      })).toThrow(/invalid channel plugin package version/);
    }
  });

  it('rejects inline channel secrets and non-JSON public config', () => {
    expect(() => v3({
      plugins: [],
      instances: {
        'lark-primary': {
          plugin: 'lark',
          enabled: true,
          configVersion: 1,
          config: {},
          secretRefs: { appSecret: 'plaintext-is-not-a-reference' },
        },
      },
    })).toThrow(/invalid secret reference/);

    expect(() => v3({
      plugins: [],
      instances: {
        'lark-primary': {
          plugin: 'lark',
          enabled: true,
          configVersion: 1,
          config: { invalid: undefined },
          secretRefs: {},
        },
      },
    })).toThrow(/JSON-serializable/);
  });
});
