import { describe, expect, it } from 'vitest';
import {
  PROFILE_ENGINE_UPDATE_COMMAND,
  managementCommandRegistry,
  profileEngineUpdateCommand,
  profileEngineUpdateParameters,
} from '../../../src/application/control';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig } from '../../../src/config/profile-store';

describe('profile engine management command', () => {
  it('commits only the prepared engine identity and model reset', () => {
    const root = fixtureRoot(true);
    const parameters = profileEngineUpdateParameters({
      expectedAgentKind: 'claude',
      expectedModel: 'claude-opus-4-8',
      targetAgentKind: 'codex',
      targetModel: null,
    });

    const first = profileEngineUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters,
    });
    const replay = profileEngineUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters,
    });

    expect(first).toEqual(replay);
    expect(profileEngineUpdateCommand).toMatchObject({
      id: PROFILE_ENGINE_UPDATE_COMMAND,
      risk: 'low',
      effect: 'engine-switch',
    });
    expect(first.root.profiles.primary).toMatchObject({
      agentKind: 'codex',
      codex: { binaryPath: 'codex' },
    });
    expect(first.root.profiles.primary?.preferences.model).toBeUndefined();
    expect(first.changes).toEqual([
      { field: 'agentKind', before: 'claude', after: 'codex' },
      { field: 'preferences.model', before: 'claude-opus-4-8', after: null },
    ]);
  });

  it('requires staged engine bootstrap and exact expected state', () => {
    expect(() => profileEngineUpdateCommand.prepare({
      root: fixtureRoot(false),
      profile: 'primary',
      parameters: profileEngineUpdateParameters({
        expectedAgentKind: 'claude',
        expectedModel: 'claude-opus-4-8',
        targetAgentKind: 'codex',
        targetModel: null,
      }),
    })).toThrow(/bootstrap has not been staged/);

    expect(() => profileEngineUpdateCommand.prepare({
      root: fixtureRoot(true),
      profile: 'primary',
      parameters: profileEngineUpdateParameters({
        expectedAgentKind: 'codex',
        expectedModel: 'claude-opus-4-8',
        targetAgentKind: 'codex',
        targetModel: null,
      }),
    })).toThrow(/engine changed/);
    expect(managementCommandRegistry.get(PROFILE_ENGINE_UPDATE_COMMAND)).toStrictEqual(
      profileEngineUpdateCommand,
    );
  });
});

function fixtureRoot(withCodex: boolean) {
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: { id: 'cli_engine_test', secret: 'secret-engine-test', tenant: 'feishu' },
    },
    ...(withCodex ? { codex: { binaryPath: 'codex' } } : {}),
  });
  profile.preferences.model = 'claude-opus-4-8';
  return createRootConfig('primary', profile);
}
