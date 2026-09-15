import { describe, expect, it, vi } from 'vitest';
import { runLarkCliIdentityPolicy } from '../../../src/lark-cli/identity-policy';

describe('identity policy execution', () => {
  it.each(['bot-only', 'user-default'] as const)('applies %s in order', async (preset) => {
    const run = vi.fn(async (_args: string[]) => ({ success: true }));
    await runLarkCliIdentityPolicy(preset, run, (result) => result.success);
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ['config', 'strict-mode', preset === 'user-default' ? 'off' : 'bot'],
      ['config', 'default-as', preset === 'user-default' ? 'auto' : 'bot'],
    ]);
  });
  it('preserves the failure and stops before changing the default identity', async () => {
    const failure = { success: false, stderr: 'policy write failed' };
    const run = vi.fn(async () => failure);
    expect(await runLarkCliIdentityPolicy('user-default', run, (r) => r.success)).toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
