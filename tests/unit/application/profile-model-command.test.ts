import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  PROFILE_MODEL_UPDATE_COMMAND,
  PROFILE_REASONING_UPDATE_COMMAND,
  managementCommandRegistry,
  profileModelUpdateCommand,
  profileModelUpdateParameters,
  profileReasoningUpdateCommand,
  profileReasoningUpdateParameters,
} from '../../../src/application/control';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig } from '../../../src/config/profile-store';

describe('profile model management commands', () => {
  it('changes the model and deterministically migrates a legacy effort', () => {
    const root = fixtureRoot();
    const parameters = profileModelUpdateParameters({ model: 'gpt-next' });

    const first = profileModelUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters,
    });
    const replay = profileModelUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters,
    });

    expect(first).toEqual(replay);
    expect(first.root.profiles.primary?.preferences).toMatchObject({
      model: 'gpt-next',
      reasoningEffort: 'high',
      reasoningEffortByModel: { 'codex:gpt-current': 'high' },
    });
    expect(first.changes).toEqual([
      {
        field: 'preferences.reasoningEffortByModel.legacy',
        before: null,
        after: 'high',
      },
      { field: 'preferences.model', before: 'gpt-current', after: 'gpt-next' },
    ]);
  });

  it('stores effort under the exact engine and resolved model', () => {
    const root = fixtureRoot();
    const candidate = profileReasoningUpdateCommand.prepare({
      root,
      profile: 'primary',
      parameters: profileReasoningUpdateParameters({
        agentKind: 'codex',
        selectedModel: 'gpt-current',
        resolvedModel: 'gpt-runtime-default',
        effort: 'xhigh',
      }),
    });

    expect(candidate.root.profiles.primary?.preferences).toMatchObject({
      reasoningEffort: 'xhigh',
      reasoningEffortByModel: { 'codex:gpt-runtime-default': 'xhigh' },
    });
    expect(candidate.changes).toEqual([
      { field: 'preferences.reasoningEffort', before: 'high', after: 'xhigh' },
      {
        field: 'preferences.reasoningEffortByModel.current',
        before: null,
        after: 'xhigh',
      },
    ]);
  });

  it('rejects stale model context and registers both bounded commands', () => {
    expect(() => profileReasoningUpdateCommand.prepare({
      root: fixtureRoot(),
      profile: 'primary',
      parameters: profileReasoningUpdateParameters({
        agentKind: 'claude',
        selectedModel: 'gpt-current',
        resolvedModel: 'gpt-current',
        effort: 'low',
      }),
    })).toThrow(/engine changed/);
    expect(() => profileReasoningUpdateCommand.prepare({
      root: fixtureRoot(),
      profile: 'primary',
      parameters: profileReasoningUpdateParameters({
        agentKind: 'codex',
        selectedModel: 'gpt-stale',
        resolvedModel: 'gpt-stale',
        effort: 'low',
      }),
    })).toThrow(/model changed/);
    expect(managementCommandRegistry.get(PROFILE_MODEL_UPDATE_COMMAND)).toStrictEqual(
      profileModelUpdateCommand,
    );
    expect(managementCommandRegistry.get(PROFILE_REASONING_UPDATE_COMMAND)).toStrictEqual(
      profileReasoningUpdateCommand,
    );
  });

  it('keeps model and reasoning adapters away from direct config writes', async () => {
    const source = await readFile(
      new URL('../../../src/commands/index.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('PROFILE_MODEL_UPDATE_COMMAND');
    expect(source).toContain('PROFILE_REASONING_UPDATE_COMMAND');
    expect(source).not.toContain('saveRootConfig');
  });
});

function fixtureRoot() {
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: { id: 'cli_model_test', secret: 'secret-model-test', tenant: 'feishu' },
    },
    codex: { binaryPath: 'codex' },
  });
  profile.preferences = {
    model: 'gpt-current',
    reasoningEffort: 'high',
  };
  return createRootConfig('primary', profile);
}
