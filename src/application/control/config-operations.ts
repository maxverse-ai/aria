import {
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
} from '../../config/schema';
import type {
  ConfigChangeOperation,
  ManagementCommandDefinition,
  ControlPlanParameters,
  ControlPlanScalar,
} from './change-types';
import { ControlChangeError } from './change-types';
import { ManagementCommandRegistry } from './management-command-registry';
import type { ManagementRuntimeEffect } from './runtime-effect';

export const LOW_RISK_CONFIG_SETTINGS = [
  'require-mention',
  'show-tool-calls',
  'message-reply',
  'cot-messages',
  'max-concurrent-runs',
  'run-idle-timeout',
  'meeting-enabled',
] as const;

export type LowRiskConfigSetting = (typeof LOW_RISK_CONFIG_SETTINGS)[number];

export interface LowRiskConfigSettingDescriptor {
  setting: LowRiskConfigSetting;
  operationId: string;
  acceptedValues: string;
  restartRequired: true;
}

export interface ControlConfigSettingsSnapshot {
  schema: 'aria.control.config-settings.v1';
  apiVersion: 1;
  settings: readonly LowRiskConfigSettingDescriptor[];
}

export const lowRiskConfigSettingDescriptors: readonly LowRiskConfigSettingDescriptor[] = [
  descriptor('require-mention', 'config.require-mention.set', 'true|false|on|off'),
  descriptor('show-tool-calls', 'config.show-tool-calls.set', 'true|false|on|off'),
  descriptor('message-reply', 'config.message-reply.set', 'card|markdown|text'),
  descriptor('cot-messages', 'config.cot-messages.set', 'off|brief|detailed'),
  descriptor('max-concurrent-runs', 'config.max-concurrent-runs.set', 'integer 1..50'),
  descriptor('run-idle-timeout', 'config.run-idle-timeout.set', 'minutes 0..120 (0 disables)'),
  descriptor('meeting-enabled', 'config.meeting-enabled.set', 'true|false|on|off'),
];

export function configSettingsSnapshot(): ControlConfigSettingsSnapshot {
  return {
    schema: 'aria.control.config-settings.v1',
    apiVersion: 1,
    settings: lowRiskConfigSettingDescriptors,
  };
}

export const lowRiskConfigCommands: readonly ManagementCommandDefinition[] = [
  operation('config.require-mention.set', 'live', ({ profile, value }) => {
    const before = getRequireMentionInGroup(profile);
    const after = booleanValue(value);
    if (before !== after) profile.access = { ...profile.access, requireMentionInGroup: after };
    return summary('access.requireMentionInGroup', before, after);
  }),
  operation('config.show-tool-calls.set', 'live', ({ profile, value }) => {
    const before = getShowToolCalls(profile);
    const after = booleanValue(value);
    if (before !== after) profile.preferences = { ...profile.preferences, showToolCalls: after };
    return summary('preferences.showToolCalls', before, after);
  }),
  operation('config.message-reply.set', 'live', ({ profile, value }) => {
    const before = getMessageReplyMode(profile);
    const after = enumValue(value, ['card', 'markdown', 'text'] as const);
    if (before !== after) {
      profile.preferences = {
        ...profile.preferences,
        messageReply: after,
        messageReplyMigrated: true,
      };
    }
    return summary('preferences.messageReply', before, after);
  }),
  operation('config.cot-messages.set', 'live', ({ profile, value }) => {
    const before = getCotMessages(profile);
    const after = enumValue(value, ['off', 'brief', 'detailed'] as const);
    if (before !== after) profile.preferences = { ...profile.preferences, cotMessages: after };
    return summary('preferences.cotMessages', before, after);
  }),
  operation('config.max-concurrent-runs.set', 'live', ({ profile, value }) => {
    const before = getMaxConcurrentRuns(profile);
    const after = integerValue(value, 1, 50);
    if (before !== after) profile.preferences = { ...profile.preferences, maxConcurrentRuns: after };
    return summary('preferences.maxConcurrentRuns', before, after);
  }),
  operation('config.run-idle-timeout.set', 'live', ({ profile, value }) => {
    const before = (getRunIdleTimeoutMs(profile) ?? 0) / 60_000;
    const after = integerValue(value, 0, 120);
    if (before !== after) {
      const preferences = { ...profile.preferences };
      if (after === 0) delete preferences.runIdleTimeoutMinutes;
      else preferences.runIdleTimeoutMinutes = after;
      profile.preferences = preferences;
    }
    return summary('preferences.runIdleTimeoutMinutes', before, after);
  }),
  operation('config.meeting-enabled.set', 'reconnect', ({ profile, value }) => {
    const before = profile.meeting.enabled;
    const after = booleanValue(value);
    if (before !== after) profile.meeting = { ...profile.meeting, enabled: after };
    return summary('meeting.enabled', before, after);
  }),
];

export const lowRiskConfigCommandRegistry = new ManagementCommandRegistry(lowRiskConfigCommands);

/** @deprecated Use `lowRiskConfigCommands` or `lowRiskConfigCommandRegistry`. */
export const lowRiskConfigOperations: readonly ConfigChangeOperation[] = lowRiskConfigCommands.map(
  ({ effect: _effect, ...command }) => ({ ...command, restartRequired: true }),
);

const settingToOperation = new Map(
  lowRiskConfigSettingDescriptors.map((item) => [item.setting, item.operationId]),
);

export function operationIdForSetting(setting: string): string {
  const operation = settingToOperation.get(setting as LowRiskConfigSetting);
  if (!operation) {
    throw new Error(`unsupported setting: ${setting}; expected one of ${LOW_RISK_CONFIG_SETTINGS.join(', ')}`);
  }
  return operation;
}

export function parseSettingValue(setting: string, raw: string): ControlPlanScalar {
  if (setting === 'require-mention' || setting === 'show-tool-calls' || setting === 'meeting-enabled') {
    if (raw === 'true' || raw === 'on') return true;
    if (raw === 'false' || raw === 'off') return false;
    throw new Error(`${setting} expects true/false or on/off`);
  }
  if (setting === 'max-concurrent-runs' || setting === 'run-idle-timeout') {
    if (!/^-?\d+$/.test(raw)) throw new Error(`${setting} expects an integer`);
    return Number(raw);
  }
  return raw;
}

function operation(
  id: string,
  effect: ManagementRuntimeEffect,
  mutate: (input: {
    profile: import('../../config/profile-schema').ProfileConfig;
    value: ControlPlanScalar | undefined;
  }) => import('./change-types').ControlChangeSummary,
): ManagementCommandDefinition {
  return {
    id,
    version: 1,
    risk: 'low',
    effect,
    prepare({ root, profile, parameters }) {
      const current = root.profiles[profile];
      if (!current) throw new Error(`profile not found: ${profile}`);
      const change = mutate({ profile: current, value: parameters.value });
      return { root, changes: [change] };
    },
  };
}

function summary(field: string, before: ControlPlanScalar, after: ControlPlanScalar) {
  return { field, before, after };
}

function booleanValue(value: ControlPlanScalar | undefined): boolean {
  if (typeof value !== 'boolean') throw new ControlChangeError('invalid-plan', 'value must be boolean');
  return value;
}

function integerValue(value: ControlPlanScalar | undefined, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ControlChangeError('invalid-plan', `value must be an integer between ${min} and ${max}`);
  }
  return value;
}

function enumValue<T extends string>(value: ControlPlanScalar | undefined, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ControlChangeError('invalid-plan', `value must be one of ${values.join(', ')}`);
  }
  return value as T;
}

function descriptor(
  setting: LowRiskConfigSetting,
  operationId: string,
  acceptedValues: string,
): LowRiskConfigSettingDescriptor {
  return { setting, operationId, acceptedValues, restartRequired: true };
}
