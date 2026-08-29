import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  PROFILE_PREFERENCES_UPDATE_COMMAND,
  managementCommandRegistry,
  profilePreferencesUpdateCommand,
  profilePreferencesUpdateParameters,
} from '../../../src/application/control';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { createRootConfig } from '../../../src/config/profile-store';
import {
  SERVICE_TIER_INHERIT,
  SERVICE_TIER_STANDARD,
} from '../../../src/agent/service-tier';

describe('profile preferences management command', () => {
  it('updates the full card payload atomically and deterministically', () => {
    const root = normalizedRoundTrip(fixtureRoot());
    const input = profilePreferencesUpdateParameters({
      mode: 'team',
      model: 'claude-opus-4-8',
      serviceTier: SERVICE_TIER_STANDARD,
      messageReply: 'text',
      showToolCalls: false,
      cotMessages: 'brief',
      runStatusTouched: true,
      runStatusItems: ['model', 'context'],
      maxConcurrentRuns: 7,
      runIdleTimeoutMinutes: 0,
      requireMentionInGroup: false,
      larkCliIdentity: 'user-default',
      larkCliRecordedAt: '2026-08-29T06:30:00.000Z',
    });

    const first = profilePreferencesUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters: input,
    });
    const replay = profilePreferencesUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters: input,
    });

    expect(first).toEqual(replay);
    expect(normalizedRoundTrip(first.root)).toEqual(first.root);
    expect(profilePreferencesUpdateCommand).toMatchObject({
      id: PROFILE_PREFERENCES_UPDATE_COMMAND,
      risk: 'low',
      effect: 'live',
    });
    expect(first.root.profiles.primary).toMatchObject({
      mode: 'team',
      preferences: {
        reasoningEffort: 'high',
        model: 'claude-opus-4-8',
        serviceTier: null,
        messageReply: 'text',
        messageReplyMigrated: true,
        showToolCalls: false,
        cotMessages: 'brief',
        runStatus: { items: ['model', 'context'] },
        maxConcurrentRuns: 7,
      },
      access: {
        allowedUsers: ['ou-allowed'],
        requireMentionInGroup: false,
      },
      larkCli: {
        identityPreset: 'user-default',
        localUserImport: {
          status: 'not-needed',
          attemptedAt: '2026-08-29T06:30:00.000Z',
          reason: 'manual-user-default',
        },
      },
    });
    expect(first.root.profiles.primary?.preferences.runIdleTimeoutMinutes).toBeUndefined();
    expect(first.root.profiles.secondary).toEqual(root.profiles.secondary);
    expect(first.changes.map((change) => change.field)).toEqual(
      expect.arrayContaining([
        'preferences.model',
        'preferences.serviceTier',
        'preferences.messageReply',
        'preferences.runStatusItems',
        'access.requireMentionInGroup',
        'mode',
        'larkCli.identityPreset',
      ]),
    );
  });

  it('preserves run-status storage when the adapter did not receive those fields', () => {
    const root = normalizedRoundTrip(fixtureRoot());
    const candidate = profilePreferencesUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters: profilePreferencesUpdateParameters({
        mode: 'personal',
        serviceTier: SERVICE_TIER_INHERIT,
        messageReply: 'markdown',
        showToolCalls: true,
        cotMessages: 'detailed',
        runStatusTouched: false,
        runStatusItems: ['agent', 'model'],
        maxConcurrentRuns: 10,
        runIdleTimeoutMinutes: 12,
        requireMentionInGroup: true,
        larkCliIdentity: 'bot-only',
        larkCliRecordedAt: '2026-08-29T06:31:00.000Z',
      }),
    });

    expect(candidate.root.profiles.primary?.preferences.runStatus).toEqual({
      items: ['weekly-limit'],
    });
    expect(normalizedRoundTrip(candidate.root)).toEqual(candidate.root);
  });

  it('rejects malformed aggregate input and is included in the public registry', () => {
    const root = normalizedRoundTrip(fixtureRoot());
    const input = profilePreferencesUpdateParameters({
      mode: 'personal',
      serviceTier: SERVICE_TIER_INHERIT,
      messageReply: 'markdown',
      showToolCalls: true,
      cotMessages: 'detailed',
      runStatusTouched: true,
      runStatusItems: ['model'],
      maxConcurrentRuns: 10,
      runIdleTimeoutMinutes: 12,
      requireMentionInGroup: true,
      larkCliIdentity: 'bot-only',
      larkCliRecordedAt: '2026-08-29T06:31:00.000Z',
    });

    expect(managementCommandRegistry.get(PROFILE_PREFERENCES_UPDATE_COMMAND)).toStrictEqual(
      profilePreferencesUpdateCommand,
    );
    expect(() => profilePreferencesUpdateCommand.prepare({
      root,
      profile: 'primary',
      parameters: { ...input, runStatusItems: 'unknown' },
    })).toThrow(/unsupported item/);
  });

  it('keeps the card adapter away from the compatibility preferences writer', async () => {
    const source = await readFile(
      new URL('../../../src/commands/index.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('PROFILE_PREFERENCES_UPDATE_COMMAND');
    expect(source).not.toContain('configOps.savePreferencesConfig');
  });
});

function fixtureRoot(): RootConfig {
  const primary = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_primary', secret: 'secret-primary', tenant: 'feishu' } },
    access: {
      allowedUsers: ['ou-allowed'],
      requireMentionInGroup: true,
    },
  });
  primary.preferences = {
    reasoningEffort: 'high',
    runStatus: { items: ['weekly-limit'] },
    runIdleTimeoutMinutes: 12,
  };
  primary.larkCli = {
    identityPreset: 'bot-only',
    localUserImport: {
      status: 'imported',
      attemptedAt: '2026-08-20T00:00:00.000Z',
      importedAt: '2026-08-20T00:01:00.000Z',
      reason: 'same-app-local-user',
    },
  };
  const root = createRootConfig('primary', primary);
  root.profiles.secondary = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_secondary', secret: 'secret-secondary', tenant: 'lark' } },
    codex: { binaryPath: 'codex' },
  });
  return root;
}

function normalizedRoundTrip(root: RootConfig): RootConfig {
  const stored = JSON.parse(JSON.stringify(root)) as RootConfig;
  return {
    schemaVersion: 2,
    activeProfile: stored.activeProfile,
    preferences: {},
    ...(stored.secrets ? { secrets: stored.secrets } : {}),
    profiles: Object.fromEntries(
      Object.entries(stored.profiles).map(([name, profile]) => [
        name,
        normalizeProfileConfig(profile),
      ]),
    ),
  };
}
