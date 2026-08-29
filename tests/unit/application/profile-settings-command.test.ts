import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  PROFILE_SETTINGS_RECONNECT_COMMAND,
  PROFILE_SETTINGS_UPDATE_COMMAND,
  managementCommandRegistry,
  nextLarkCliRecordedAt,
  profileSettingsReconnectCommand,
  profileSettingsUpdateCommand,
  profileSettingsUpdateParameters,
} from '../../../src/application/control';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
  type MeetingConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { createRootConfig } from '../../../src/config/profile-store';

describe('profile settings management commands', () => {
  it('updates preferences and non-lifecycle meeting settings atomically with a live effect', () => {
    const root = normalizedRoundTrip(fixtureRoot());
    const input = profileSettingsUpdateParameters({
      mode: 'team',
      model: 'claude-opus-4-8',
      messageReply: 'text',
      showToolCalls: false,
      cotMessages: 'brief',
      runStatusTouched: false,
      runStatusItems: ['model'],
      maxConcurrentRuns: 7,
      runIdleTimeoutMinutes: 0,
      requireMentionInGroup: false,
      larkCliIdentity: 'user-default',
      larkCliRecordedAt: '2026-08-29T08:00:00.000Z',
      meeting: meeting({ trigger: '@aria', pollIntervalMs: 5000 }),
    });

    const first = profileSettingsUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters: input,
    });
    const replay = profileSettingsUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters: input,
    });

    expect(first).toEqual(replay);
    expect(profileSettingsUpdateCommand).toMatchObject({
      id: PROFILE_SETTINGS_UPDATE_COMMAND,
      effect: 'live',
    });
    expect(first.root.profiles.primary).toMatchObject({
      mode: 'team',
      preferences: {
        model: 'claude-opus-4-8',
        messageReply: 'text',
        maxConcurrentRuns: 7,
      },
      access: { requireMentionInGroup: false },
      meeting: { enabled: false, trigger: '@aria', pollIntervalMs: 5000 },
    });
    expect(first.root.profiles.secondary).toEqual(root.profiles.secondary);
    expect(first.changes.map((change) => change.field)).toEqual(
      expect.arrayContaining([
        'preferences.model',
        'mode',
        'meeting.trigger',
        'meeting.pollIntervalMs',
      ]),
    );
    expect(normalizedRoundTrip(first.root)).toEqual(first.root);
  });

  it('requires the reconnect variant for meeting enablement transitions', () => {
    const root = normalizedRoundTrip(fixtureRoot());
    const input = profileSettingsUpdateParameters({
      mode: 'personal',
      messageReply: 'markdown',
      showToolCalls: true,
      cotMessages: 'detailed',
      runStatusTouched: false,
      runStatusItems: [],
      maxConcurrentRuns: 10,
      runIdleTimeoutMinutes: 0,
      requireMentionInGroup: true,
      larkCliIdentity: 'bot-only',
      larkCliRecordedAt: '2026-08-29T08:01:00.000Z',
      meeting: meeting({ enabled: true }),
    });

    expect(() => profileSettingsUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters: input,
    })).toThrow(/require profile\.settings\.update-reconnect/);

    const candidate = profileSettingsReconnectCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters: input,
    });
    expect(profileSettingsReconnectCommand).toMatchObject({
      id: PROFILE_SETTINGS_RECONNECT_COMMAND,
      effect: 'reconnect',
    });
    expect(candidate.root.profiles.primary?.meeting.enabled).toBe(true);
  });

  it('validates the complete scalar contract and publishes both variants', () => {
    const root = normalizedRoundTrip(fixtureRoot());
    const input = profileSettingsUpdateParameters({
      mode: 'personal',
      messageReply: 'markdown',
      showToolCalls: true,
      cotMessages: 'detailed',
      runStatusTouched: false,
      runStatusItems: [],
      maxConcurrentRuns: 10,
      runIdleTimeoutMinutes: 0,
      requireMentionInGroup: true,
      larkCliIdentity: 'bot-only',
      larkCliRecordedAt: '2026-08-29T08:02:00.000Z',
      meeting: meeting(),
    });

    expect(() => profileSettingsUpdateCommand.prepare({
      root,
      profile: 'primary',
      parameters: { ...input, meetingPollIntervalMs: 999 },
    })).toThrow(/between 1000 and 60000/);
    expect(managementCommandRegistry.get(PROFILE_SETTINGS_UPDATE_COMMAND)).toStrictEqual(
      profileSettingsUpdateCommand,
    );
    expect(managementCommandRegistry.get(PROFILE_SETTINGS_RECONNECT_COMMAND)).toStrictEqual(
      profileSettingsReconnectCommand,
    );
  });

  it('shares a monotonic lark-cli observation timestamp across adapters', () => {
    expect(nextLarkCliRecordedAt('2026-08-29T08:00:00.000Z', Date.parse('2026-08-29T07:00:00.000Z')))
      .toBe('2026-08-29T08:00:00.001Z');
    expect(nextLarkCliRecordedAt(undefined, Date.parse('2026-08-29T09:00:00.000Z')))
      .toBe('2026-08-29T09:00:00.000Z');
  });

  it('keeps the web adapter away from the compatibility preferences writer', async () => {
    const source = await readFile(new URL('../../../src/ui/api.ts', import.meta.url), 'utf8');
    expect(source).toContain('PROFILE_SETTINGS_UPDATE_COMMAND');
    expect(source).not.toContain('savePreferencesConfig');
  });
});

function meeting(overrides: Partial<MeetingConfig> = {}): MeetingConfig {
  return {
    enabled: false,
    autoJoinOnInvite: false,
    transcript: { keep: 200, stabilizeMs: 0 },
    respondIn: 'meeting',
    trigger: '@bot',
    pollIntervalMs: 3000,
    summaryOnEnd: false,
    summaryTarget: 'origin',
    ...overrides,
  };
}

function fixtureRoot(): RootConfig {
  const primary = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_primary', secret: 'secret-primary', tenant: 'feishu' } },
  });
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
