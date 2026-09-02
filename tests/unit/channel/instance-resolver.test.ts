import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { AppCredentials } from '../../../src/config/schema';
import {
  BUILT_IN_LARK_CONFIG_VERSION,
  BUILT_IN_LARK_PLUGIN_ID,
  projectSchemaV2ChannelInstances,
  SCHEMA_V2_LARK_INSTANCE_ID,
} from '../../../src/channel/instance-resolver';

const baseApp = {
  id: 'cli_projection',
  secret: { source: 'exec' as const, provider: 'bridge', id: 'app-cli_projection' },
  tenant: 'feishu' as const,
};

function profile(app: AppCredentials = baseApp) {
  return createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app },
    plugins: ['engine-package-that-is-not-a-channel'],
  });
}

describe('schema-v2 channel instance projection', () => {
  it('projects the legacy Lark binding into one canonical validated instance', () => {
    const [instance] = projectSchemaV2ChannelInstances({
      profileId: 'work',
      profile: profile(),
    });

    expect(instance).toEqual({
      profileId: 'work',
      pluginId: BUILT_IN_LARK_PLUGIN_ID,
      instanceId: SCHEMA_V2_LARK_INSTANCE_ID,
      enabled: true,
      configVersion: BUILT_IN_LARK_CONFIG_VERSION,
      config: {
        appId: 'cli_projection',
        tenant: 'feishu',
        credentialMode: 'secret-ref',
      },
      secretRefs: {
        appSecret: {
          source: 'exec',
          provider: 'bridge',
          id: 'app-cli_projection',
        },
      },
    });
    expect(JSON.stringify(instance)).not.toContain('engine-package-that-is-not-a-channel');
  });

  it('normalizes an environment template into a SecretRef', () => {
    const [instance] = projectSchemaV2ChannelInstances({
      profileId: 'work',
      profile: profile({ ...baseApp, secret: '${LARK_APP_SECRET}' }),
    });

    expect(instance.config.credentialMode).toBe('env-template');
    expect(instance.secretRefs).toEqual({
      appSecret: { source: 'env', id: 'LARK_APP_SECRET' },
    });
  });

  it('never copies a legacy inline secret into the resolved instance', () => {
    const secret = 'super-secret-legacy-value';
    const [instance] = projectSchemaV2ChannelInstances({
      profileId: 'work',
      profile: profile({ ...baseApp, secret }),
    });

    expect(instance.config.credentialMode).toBe('legacy-inline');
    expect(instance.secretRefs).toEqual({});
    expect(JSON.stringify(instance)).not.toContain(secret);
  });

  it('returns a deterministic detached and immutable projection', () => {
    const input = profile();
    const first = projectSchemaV2ChannelInstances({ profileId: 'work', profile: input });
    const second = projectSchemaV2ChannelInstances({
      profileId: 'work',
      profile: structuredClone(input),
    });

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0].config)).toBe(true);
    expect(Object.isFrozen(first[0].secretRefs)).toBe(true);
    expect(first[0].secretRefs.appSecret).not.toBe(input.accounts.app.secret);

    input.accounts.app.id = 'cli_changed_after_projection';
    expect(first[0].config.appId).toBe('cli_projection');
  });

  it('does not synthesize either WeChat entry from a Lark profile', () => {
    const instances = projectSchemaV2ChannelInstances({
      profileId: 'work',
      profile: profile(),
    });
    expect(instances.map((instance) => instance.pluginId)).toEqual(['lark']);
    expect(JSON.stringify(instances)).not.toContain('wechat-kf');
    expect(JSON.stringify(instances)).not.toContain('weixin-ilink');
  });

  it('rejects unsupported profile schema without echoing input data', () => {
    expect(() =>
      projectSchemaV2ChannelInstances({
        profileId: 'work',
        profile: { ...profile(), schemaVersion: 3 as never },
      }),
    ).toThrow(/unsupported profile schema/);
  });
});
