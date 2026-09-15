import { describe, expect, it } from 'vitest';
import { evaluateEffectivePolicy, type EffectivePolicyInput } from '../../../src/policy/effective-policy';
import { legacyEnginePermissions } from '../../../src/agent/permission-policy';

const base: EffectivePolicyInput = {
  admitted: { ok: true, reason: 'allowed-user' }, defaultAccess: 'full',
  profileCeiling: 'full', engineCeiling: 'full',
  hasUnverifiedFolder: false, hasRejectedRequiredAttachment: false, now: 1000,
};
describe('effective resource policy', () => {
  it.each(['profileCeiling', 'engineCeiling', 'grantCeiling'] as const)('never exceeds the %s', (key) => {
    const decision = evaluateEffectivePolicy({ ...base, [key]: 'read-only' });
    expect(decision).toEqual({ ok: true, policy: { accessMode: 'read-only', expiresAt: 301000 } });
    if (!decision.ok) throw new Error('expected allow');
    expect(legacyEnginePermissions(decision.policy, {
      defaultAccess: 'full', maxAccess: 'full', claude: { permissionMode: 'bypassPermissions' },
    })).toEqual({ sandbox: 'read-only', permissionMode: 'plan' });
  });
  it('does not let a live engine capability grant access denied by admission', () => {
    expect(evaluateEffectivePolicy({ ...base, admitted: { ok: false, reason: 'denied-user' } }))
      .toEqual({ ok: false, code: 'access-denied' });
  });
});
