import { describe, expect, it } from 'vitest';
import {
  CURRENT_DEFAULT_LARK_CHANNEL_ROLLOUT_MODE,
  resolveLarkChannelOwnership,
  type LarkChannelRolloutMode,
} from '../../../src/channel/lark-ownership';

describe('Lark channel ownership policy', () => {
  it('keeps the current no-flag default in shadow mode', () => {
    expect(CURRENT_DEFAULT_LARK_CHANNEL_ROLLOUT_MODE).toBe('shadow');
    expect(resolveLarkChannelOwnership(undefined)).toEqual({
      mode: 'shadow',
      owner: 'legacy',
      managerEnabled: true,
    });
  });

  it.each([
    ['off', 'legacy', false],
    ['shadow', 'legacy', true],
    ['opt-in', 'manager', true],
    ['default-on', 'manager', true],
  ] as const)('maps %s to exactly one owner', (mode, owner, managerEnabled) => {
    expect(resolveLarkChannelOwnership(mode)).toEqual({ mode, owner, managerEnabled });
  });

  it('supports a future reviewed default-on flip without changing explicit rollback modes', () => {
    expect(resolveLarkChannelOwnership(undefined, 'default-on')).toMatchObject({
      mode: 'default-on',
      owner: 'manager',
    });
    expect(resolveLarkChannelOwnership('off', 'default-on')).toMatchObject({
      mode: 'off',
      owner: 'legacy',
    });
  });

  it('fails closed for an unknown mode', () => {
    expect(() =>
      resolveLarkChannelOwnership('both' as LarkChannelRolloutMode),
    ).toThrow(/invalid Lark channel rollout mode/);
  });
});
