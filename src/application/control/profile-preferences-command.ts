import type {
  LarkCliIdentityPreset,
  ProfileMode,
} from '../../config/profile-schema';
import type { CotMessagesMode, MessageReplyMode } from '../../config/schema';
import {
  DEFAULT_RUN_STATUS_ITEMS,
  isRunStatusItemId,
  type RunStatusItemId,
} from '../../run-status/items';
import {
  compactRunStatusPreference,
  getRunStatusItems,
} from '../../run-status/preferences';
import {
  ControlChangeError,
  type ControlChangeSummary,
  type ControlPlanParameters,
  type ControlPlanScalar,
  type ManagementCommandDefinition,
} from './change-types';
import { lowRiskConfigCommandRegistry } from './config-operations';

export const PROFILE_PREFERENCES_UPDATE_COMMAND = 'profile.preferences.update';

export interface ProfilePreferencesUpdateInput {
  mode: ProfileMode;
  model?: string;
  messageReply: MessageReplyMode;
  showToolCalls: boolean;
  cotMessages: CotMessagesMode;
  runStatusTouched: boolean;
  runStatusItems: readonly RunStatusItemId[];
  maxConcurrentRuns: number;
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  larkCliIdentity: LarkCliIdentityPreset;
  /** Adapter-supplied timestamp keeps command replay deterministic. */
  larkCliRecordedAt: string;
}

const PARAMETER_KEYS = [
  'mode',
  'model',
  'messageReply',
  'showToolCalls',
  'cotMessages',
  'runStatusTouched',
  'runStatusItems',
  'maxConcurrentRuns',
  'runIdleTimeoutMinutes',
  'requireMentionInGroup',
  'larkCliIdentity',
  'larkCliRecordedAt',
] as const;

export function profilePreferencesUpdateParameters(
  input: ProfilePreferencesUpdateInput,
): ControlPlanParameters {
  return {
    mode: input.mode,
    model: input.model ?? null,
    messageReply: input.messageReply,
    showToolCalls: input.showToolCalls,
    cotMessages: input.cotMessages,
    runStatusTouched: input.runStatusTouched,
    runStatusItems: input.runStatusItems.join(','),
    maxConcurrentRuns: input.maxConcurrentRuns,
    runIdleTimeoutMinutes: input.runIdleTimeoutMinutes,
    requireMentionInGroup: input.requireMentionInGroup,
    larkCliIdentity: input.larkCliIdentity,
    larkCliRecordedAt: input.larkCliRecordedAt,
  };
}

export const profilePreferencesUpdateCommand: ManagementCommandDefinition = {
  id: PROFILE_PREFERENCES_UPDATE_COMMAND,
  version: 1,
  risk: 'low',
  effect: 'live',
  prepare({ root, profile, parameters }) {
    const current = root.profiles[profile];
    if (!current) throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
    const input = parseInput(parameters);
    const changes: ControlChangeSummary[] = [];
    const messageReplyMigratedBefore = current.preferences.messageReplyMigrated === true;

    for (const [command, value] of [
      ['config.require-mention.set', input.requireMentionInGroup],
      ['config.show-tool-calls.set', input.showToolCalls],
      ['config.message-reply.set', input.messageReply],
      ['config.cot-messages.set', input.cotMessages],
      ['config.max-concurrent-runs.set', input.maxConcurrentRuns],
      ['config.run-idle-timeout.set', input.runIdleTimeoutMinutes],
    ] as const) {
      const operation = lowRiskConfigCommandRegistry.get(command);
      if (!operation) {
        throw new ControlChangeError('operation-unavailable', `operation unavailable: ${command}`);
      }
      changes.push(...operation.prepare({ root, profile, parameters: { value } }).changes);
    }

    const target = root.profiles[profile]!;
    if (!messageReplyMigratedBefore) {
      target.preferences = { ...target.preferences, messageReplyMigrated: true };
    }
    changes.push(
      summary('preferences.messageReplyMigrated', messageReplyMigratedBefore, true),
    );

    const modelBefore = target.preferences.model ?? null;
    const preferences = { ...target.preferences };
    if (input.model === null) delete preferences.model;
    else preferences.model = input.model;
    target.preferences = preferences;
    changes.push(summary('preferences.model', modelBefore, input.model));

    if (input.runStatusTouched) {
      const before = encodeRunStatusItems(getRunStatusItems(target.preferences));
      target.preferences = {
        ...target.preferences,
        runStatus: compactRunStatusPreference(input.runStatusItems),
      };
      changes.push(
        summary('preferences.runStatusItems', before, encodeRunStatusItems(input.runStatusItems)),
      );
    }

    const modeBefore = target.mode;
    target.mode = input.mode;
    changes.push(summary('mode', modeBefore, input.mode));

    const larkCliBefore = target.larkCli;
    const reason = input.larkCliIdentity === 'user-default'
      ? 'manual-user-default'
      : 'manual-bot-only';
    target.larkCli = {
      identityPreset: input.larkCliIdentity,
      localUserImport: {
        status: 'not-needed',
        attemptedAt: input.larkCliRecordedAt,
        reason,
      },
    };
    changes.push(
      summary('larkCli.identityPreset', larkCliBefore.identityPreset, input.larkCliIdentity),
      summary(
        'larkCli.localUserImport.status',
        larkCliBefore.localUserImport?.status ?? null,
        'not-needed',
      ),
      summary(
        'larkCli.localUserImport.attemptedAt',
        larkCliBefore.localUserImport?.attemptedAt ?? null,
        input.larkCliRecordedAt,
      ),
      summary(
        'larkCli.localUserImport.importedAt',
        larkCliBefore.localUserImport?.importedAt ?? null,
        null,
      ),
      summary(
        'larkCli.localUserImport.reason',
        larkCliBefore.localUserImport?.reason ?? null,
        reason,
      ),
    );

    return { root, changes };
  },
};

interface ParsedProfilePreferencesUpdateInput
  extends Omit<ProfilePreferencesUpdateInput, 'model'> {
  model: string | null;
}

function parseInput(parameters: ControlPlanParameters): ParsedProfilePreferencesUpdateInput {
  assertExactKeys(parameters);
  return {
    mode: enumValue(parameters.mode, ['personal', 'team'] as const, 'mode'),
    model: optionalString(parameters.model, 'model'),
    messageReply: enumValue(
      parameters.messageReply,
      ['card', 'markdown', 'text'] as const,
      'messageReply',
    ),
    showToolCalls: booleanValue(parameters.showToolCalls, 'showToolCalls'),
    cotMessages: enumValue(
      parameters.cotMessages,
      ['off', 'brief', 'detailed'] as const,
      'cotMessages',
    ),
    runStatusTouched: booleanValue(parameters.runStatusTouched, 'runStatusTouched'),
    runStatusItems: parseRunStatusItems(parameters.runStatusItems),
    maxConcurrentRuns: integerValue(parameters.maxConcurrentRuns, 1, 50, 'maxConcurrentRuns'),
    runIdleTimeoutMinutes: integerValue(
      parameters.runIdleTimeoutMinutes,
      0,
      120,
      'runIdleTimeoutMinutes',
    ),
    requireMentionInGroup: booleanValue(
      parameters.requireMentionInGroup,
      'requireMentionInGroup',
    ),
    larkCliIdentity: enumValue(
      parameters.larkCliIdentity,
      ['bot-only', 'user-default'] as const,
      'larkCliIdentity',
    ),
    larkCliRecordedAt: isoTimestamp(parameters.larkCliRecordedAt),
  };
}

function assertExactKeys(parameters: ControlPlanParameters): void {
  const actual = Object.keys(parameters).sort();
  const expected = [...PARAMETER_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ControlChangeError(
      'invalid-plan',
      `parameters must contain exactly: ${PARAMETER_KEYS.join(', ')}`,
    );
  }
}

function booleanValue(value: ControlPlanScalar | undefined, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ControlChangeError('invalid-plan', `${field} must be boolean`);
  }
  return value;
}

function integerValue(
  value: ControlPlanScalar | undefined,
  min: number,
  max: number,
  field: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ControlChangeError(
      'invalid-plan',
      `${field} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

function enumValue<T extends string>(
  value: ControlPlanScalar | undefined,
  values: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ControlChangeError('invalid-plan', `${field} must be one of ${values.join(', ')}`);
  }
  return value as T;
}

function optionalString(value: ControlPlanScalar | undefined, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ControlChangeError('invalid-plan', `${field} must be a non-empty string or null`);
  }
  return value;
}

function parseRunStatusItems(value: ControlPlanScalar | undefined): readonly RunStatusItemId[] {
  if (typeof value !== 'string') {
    throw new ControlChangeError('invalid-plan', 'runStatusItems must be a comma-separated string');
  }
  const items = value === '' ? [] : value.split(',');
  if (new Set(items).size !== items.length || items.some((item) => !isRunStatusItemId(item))) {
    throw new ControlChangeError('invalid-plan', 'runStatusItems contains an unsupported item');
  }
  const selected = new Set(items);
  return DEFAULT_RUN_STATUS_ITEMS.filter((item) => selected.has(item));
}

function isoTimestamp(value: ControlPlanScalar | undefined): string {
  if (
    typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new ControlChangeError('invalid-plan', 'larkCliRecordedAt must be an ISO timestamp');
  }
  return value;
}

function encodeRunStatusItems(items: readonly RunStatusItemId[]): string {
  return items.join(',');
}

function summary(
  field: string,
  before: ControlPlanScalar,
  after: ControlPlanScalar,
): ControlChangeSummary {
  return { field, before, after };
}
