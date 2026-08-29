import { describe, expect, it } from 'vitest';
import {
  lowRiskConfigCommandRegistry,
  lowRiskConfigCommands,
  lowRiskConfigOperations,
  operationIdForSetting,
  parseSettingValue,
} from '../../../src/application/control';
import { createRootConfig } from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('low-risk config operations', () => {
  it.each([
    ['require-mention', false, 'access.requireMentionInGroup', false],
    ['show-tool-calls', false, 'preferences.showToolCalls', false],
    ['message-reply', 'text', 'preferences.messageReply', 'text'],
    ['cot-messages', 'brief', 'preferences.cotMessages', 'brief'],
    ['max-concurrent-runs', 4, 'preferences.maxConcurrentRuns', 4],
    ['run-idle-timeout', 12, 'preferences.runIdleTimeoutMinutes', 12],
    ['meeting-enabled', true, 'meeting.enabled', true],
  ] as const)('prepares %s through an explicit deterministic operation', (setting, value, field, after) => {
    const root = fixtureRoot();
    const id = operationIdForSetting(setting);
    const operation = lowRiskConfigCommandRegistry.get(id)!;

    const candidate = operation.prepare({ root, profile: 'primary', parameters: { value } });

    expect(operation).toMatchObject({ risk: 'low', effect: 'restart' });
    expect(candidate.changes).toEqual([expect.objectContaining({ field, after })]);
  });

  it('keeps the legacy restart-required operation view as a compatibility adapter', () => {
    expect(lowRiskConfigCommands).toHaveLength(lowRiskConfigOperations.length);
    expect(lowRiskConfigOperations.every((operation) => operation.restartRequired)).toBe(true);
    expect(lowRiskConfigOperations.map((operation) => operation.id)).toEqual(
      lowRiskConfigCommands.map((command) => command.id),
    );
  });

  it('parses CLI values and rejects invalid setting values', () => {
    expect(parseSettingValue('require-mention', 'off')).toBe(false);
    expect(parseSettingValue('max-concurrent-runs', '7')).toBe(7);
    expect(parseSettingValue('message-reply', 'card')).toBe('card');
    expect(() => parseSettingValue('show-tool-calls', 'maybe')).toThrow(/expects/);
    expect(() => operationIdForSetting('app-secret')).toThrow(/unsupported setting/);
  });
});

function fixtureRoot() {
  return createRootConfig(
    'primary',
    createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'cli_test', secret: 'secret-test', tenant: 'feishu' } },
      access: { requireMentionInGroup: true },
      codex: { binaryPath: 'codex' },
    }),
  );
}
