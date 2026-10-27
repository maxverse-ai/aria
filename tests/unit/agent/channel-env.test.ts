import { describe, expect, it } from 'vitest';
import { buildChannelEnv } from '../../../src/agent/channel-env';

describe('explicit channel environment', () => {
  it('does not introduce a Feishu marker for generic engine runs', () => {
    expect(buildChannelEnv()).toEqual({});
  });

  it('retains the marker and locator bindings for an explicit channel', () => {
    expect(buildChannelEnv({ profile: 'feishu', configPath: '/bound/config.json' })).toEqual({
      LARK_CHANNEL: '1', LARK_CHANNEL_PROFILE: 'feishu', LARK_CHANNEL_CONFIG: '/bound/config.json',
    });
  });
});
