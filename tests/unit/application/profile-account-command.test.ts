import { describe, expect, it } from 'vitest';
import {
  PROFILE_ACCOUNT_UPDATE_COMMAND,
  nextAccountRecordedAt,
  profileAccountUpdateCommand,
  profileAccountUpdateParameters,
} from '../../../src/application/control';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig } from '../../../src/config/profile-store';
import { secretKeyForApp } from '../../../src/config/schema';
import { secretsGetterWrapperPath } from '../../../src/config/store';

describe('profile account management command', () => {
  it('writes only an external secret reference and profile-scoped provider configuration', () => {
    const root = fixtureRoot();
    const candidate = profileAccountUpdateCommand.prepare({
      root: structuredClone(root),
      rootDir: '/state/aria',
      profile: 'primary',
      parameters: profileAccountUpdateParameters({
        application: 'cli_replacement',
        tenant: 'lark',
        recordedAt: '2026-08-29T09:00:00.000Z',
      }),
    });

    expect(profileAccountUpdateCommand).toMatchObject({
      id: PROFILE_ACCOUNT_UPDATE_COMMAND,
      risk: 'sensitive',
      effect: 'reconnect',
      parameterPrivacy: 'private-identifiers',
    });
    expect(candidate.root.profiles.primary?.accounts).toEqual({
      app: {
        id: 'cli_replacement',
        tenant: 'lark',
        secret: {
          source: 'exec',
          provider: 'bridge',
          id: secretKeyForApp('cli_replacement'),
        },
      },
      recordedAt: '2026-08-29T09:00:00.000Z',
    });
    expect(candidate.root.profiles.primary?.secrets?.providers?.bridge?.command).toBe(
      secretsGetterWrapperPath(resolveAppPaths({ rootDir: '/state/aria', profile: 'primary' })),
    );
    expect(candidate.root.secrets).toEqual(root.secrets);
    expect(candidate.root.profiles.secondary).toEqual(root.profiles.secondary);
    expect(JSON.stringify(candidate.changes)).not.toContain('cli_replacement');
    expect(JSON.stringify(candidate)).not.toContain('plaintext-replacement');
  });

  it('uses recordedAt to version and reconnect same-application secret rotations', () => {
    const root = fixtureRoot();
    root.profiles.primary!.accounts.recordedAt = '2026-08-29T09:00:00.000Z';
    const candidate = profileAccountUpdateCommand.prepare({
      root: structuredClone(root),
      rootDir: '/state/aria',
      profile: 'primary',
      parameters: profileAccountUpdateParameters({
        application: 'cli_primary',
        tenant: 'feishu',
        recordedAt: '2026-08-29T09:00:00.001Z',
      }),
    });

    expect(candidate.root.profiles.primary?.accounts.recordedAt).toBe(
      '2026-08-29T09:00:00.001Z',
    );
    expect(candidate.changes).toEqual([
      {
        field: 'account.recordedAt',
        before: '2026-08-29T09:00:00.000Z',
        after: '2026-08-29T09:00:00.001Z',
      },
    ]);
    expect(nextAccountRecordedAt(
      '2026-08-29T09:00:00.000Z',
      new Date('2026-08-29T08:00:00.000Z'),
    )).toBe('2026-08-29T09:00:00.001Z');
  });

  it('rejects malformed application identifiers and timestamps', () => {
    const root = fixtureRoot();
    expect(() => profileAccountUpdateCommand.prepare({
      root: structuredClone(root),
      rootDir: '/state/aria',
      profile: 'primary',
      parameters: profileAccountUpdateParameters({
        application: 'cli bad',
        tenant: 'feishu',
        recordedAt: 'not-a-time',
      }),
    })).toThrow(/application must be a valid identifier/);
  });
});

function fixtureRoot() {
  const primary = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_primary', secret: 'super-secret', tenant: 'feishu' } },
  });
  const root = createRootConfig('primary', primary, {
    providers: {
      bridge: { source: 'exec', command: '/legacy/secrets-getter', args: [] },
    },
  });
  root.profiles.secondary = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_secondary', secret: 'other-secret', tenant: 'lark' } },
  });
  return root;
}
