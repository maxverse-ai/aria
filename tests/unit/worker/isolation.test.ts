import { describe, expect, it } from 'vitest';
import { assertIsolatedWorkerEnvironment } from '../../../src/worker/isolation';

describe('assertIsolatedWorkerEnvironment', () => {
  it('accepts a channel-free worker environment', () => {
    expect(() => assertIsolatedWorkerEnvironment({
      HOME: '/srv/chord-worker',
      PATH: '/usr/bin',
      CODEX_HOME: '/srv/chord-worker/codex',
    })).not.toThrow();
  });

  it.each([
    'LARK_CHANNEL',
    'LARK_CHANNEL_HOME',
    'LARK_CHANNEL_PROFILE',
    'LARK_CHANNEL_CONFIG',
    'LARK_APP_SECRET',
    'LARKSUITE_CLI_CONFIG_DIR',
    'FEISHU_APP_SECRET',
    'ARIA_HOME',
    'ARIA_WORKSPACE_HOME',
    'ARIA_TRIGGER_RUNTIME',
    'ARIA_UI_PORT',
    'ARIA_UI_TOKEN_FILE',
  ])('rejects inherited supervisor variable %s', (key) => {
    expect(() => assertIsolatedWorkerEnvironment({ [key]: 'sensitive-value' }))
      .toThrow(key);
  });

  it('does not disclose forbidden environment values', () => {
    expect(() => assertIsolatedWorkerEnvironment({
      LARK_CHANNEL_CONFIG: '/secret/channel/config.json',
    })).toThrowError(/LARK_CHANNEL_CONFIG/);

    try {
      assertIsolatedWorkerEnvironment({
        LARK_CHANNEL_CONFIG: '/secret/channel/config.json',
      });
    } catch (error) {
      expect(String(error)).not.toContain('/secret/channel/config.json');
    }
  });
});
