import { describe, expect, it } from 'vitest';
import { buildAgentLaunchEnv } from '../../../src/agent/launch-env.js';

describe('agent launch environment', () => {
  it('preserves normal Aria inheritance when no outbound policy is configured', () => {
    expect(buildAgentLaunchEnv({}, {
      LARK_APP_SECRET: 'kept-for-compatible-default',
      ORDINARY_VALUE: 'ok',
    })).toEqual({
      LARK_APP_SECRET: 'kept-for-compatible-default',
      ORDINARY_VALUE: 'ok',
    });
  });

  it('keeps only bound bridge locators when a policy module is configured', () => {
    const env = buildAgentLaunchEnv(
      {
        LARK_CHANNEL: '1',
        LARK_CHANNEL_PROFILE: 'aria',
        LARK_CHANNEL_CONFIG: '/safe/source.json',
        LARKSUITE_CLI_CONFIG_DIR: '/safe/lark-cli',
        CODEX_HOME: '/safe/codex',
      },
      {
        LARK_CHANNEL_OUTBOUND_POLICY_MODULE: 'file:///policy.mjs',
        LARK_APP_SECRET: 'secret',
        FEISHU_ACCESS_TOKEN: 'token',
        BRIDGE_AUTH_KEY: 'key',
        ORDINARY_VALUE: 'ok',
      },
    );

    expect(env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'aria',
      LARK_CHANNEL_CONFIG: '/safe/source.json',
      LARKSUITE_CLI_CONFIG_DIR: '/safe/lark-cli',
      CODEX_HOME: '/safe/codex',
      ORDINARY_VALUE: 'ok',
    });
    expect(env.LARK_CHANNEL_OUTBOUND_POLICY_MODULE).toBeUndefined();
    expect(env.LARK_APP_SECRET).toBeUndefined();
    expect(env.FEISHU_ACCESS_TOKEN).toBeUndefined();
    expect(env.BRIDGE_AUTH_KEY).toBeUndefined();
  });
});
