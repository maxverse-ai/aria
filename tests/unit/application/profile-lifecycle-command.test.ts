import { describe, expect, it } from 'vitest';
import {
  profileArchiveCommand,
  profileCreateCommand,
  profileCreateParameters,
  profilePurgeCommand,
} from '../../../src/application/control';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { createRootConfig } from '../../../src/config/profile-store';

describe('profile lifecycle commands', () => {
  it('adds a prepared profile without publishing its private definition in changes', () => {
    const root = fixtureRoot();
    const definition = preparedProfile('cli_secondary');

    const mutation = profileCreateCommand.prepare({
      root,
      profile: 'secondary',
      parameters: profileCreateParameters(definition),
    });

    expect(mutation.root.profiles.secondary?.accounts.app.id).toBe('cli_secondary');
    expect(mutation.root.profiles.secondary?.secrets).toBeUndefined();
    expect(mutation.root.secrets?.providers?.bridge?.source).toBe('exec');
    expect(mutation.changes).toEqual([
      { field: 'profiles.count', before: 1, after: 2 },
      { field: 'profile.created', before: false, after: true },
    ]);
    expect(JSON.stringify(mutation.changes)).not.toContain('cli_secondary');
  });

  it('rejects a prepared profile containing a plaintext app secret', () => {
    const root = fixtureRoot();
    const config = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_plain', secret: 'plaintext', tenant: 'feishu' } },
    });

    expect(() => profileCreateCommand.prepare({
      root,
      profile: 'plain',
      parameters: profileCreateParameters({ config }),
    })).toThrow(/external app secret/);
  });

  it('archives an active profile and selects the stable lexical fallback', () => {
    const root = fixtureRoot();
    root.profiles.zeta = preparedProfile('cli_zeta').config;
    root.profiles.alpha = preparedProfile('cli_alpha').config;

    const mutation = profileArchiveCommand.prepare({
      root,
      profile: 'primary',
      parameters: {},
    });

    expect(mutation.deleteRoot).toBeUndefined();
    expect(mutation.root.activeProfile).toBe('alpha');
    expect(Object.keys(mutation.root.profiles).sort()).toEqual(['alpha', 'zeta']);
  });

  it('declares root teardown when purging the final profile', () => {
    const root = fixtureRoot();

    const mutation = profilePurgeCommand.prepare({
      root,
      profile: 'primary',
      parameters: {},
    });

    expect(mutation.deleteRoot).toBe(true);
    expect(mutation.root).toBe(root);
    expect(mutation.changes).toContainEqual({
      field: 'root.removed',
      before: false,
      after: true,
    });
  });
});

function fixtureRoot(): RootConfig {
  const definition = preparedProfile('cli_primary');
  return createRootConfig('primary', definition.config, definition.rootSecrets);
}

function preparedProfile(appId: string) {
  const rootSecrets = {
    providers: {
      bridge: {
        source: 'exec' as const,
        command: '/opt/aria/secrets-getter',
        args: [],
      },
    },
  };
  return {
    config: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: {
          id: appId,
          secret: { source: 'exec', provider: 'bridge', id: `app-${appId}` },
          tenant: 'feishu',
        },
      },
      secrets: rootSecrets,
    }),
    rootSecrets,
  };
}
