import type { MeetingConfig } from '../../config/profile-schema';
import {
  ControlChangeError,
  type ControlChangeSummary,
  type ControlPlanParameters,
  type ControlPlanScalar,
  type ManagementCommandDefinition,
} from './change-types';
import {
  profilePreferencesUpdateCommand,
  profilePreferencesUpdateParameters,
  type ProfilePreferencesUpdateInput,
} from './profile-preferences-command';

export const PROFILE_SETTINGS_UPDATE_COMMAND = 'profile.settings.update';
export const PROFILE_SETTINGS_RECONNECT_COMMAND = 'profile.settings.update-reconnect';

export interface ProfileSettingsUpdateInput extends ProfilePreferencesUpdateInput {
  meeting: MeetingConfig;
}

const PREFERENCE_PARAMETER_KEYS = [
  'mode',
  'model',
  'serviceTier',
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

const PARAMETER_KEYS = [
  ...PREFERENCE_PARAMETER_KEYS,
  'meetingEnabled',
  'meetingAutoJoinOnInvite',
  'meetingTranscriptKeep',
  'meetingTranscriptStabilizeMs',
  'meetingRespondIn',
  'meetingTrigger',
  'meetingPollIntervalMs',
  'meetingSummaryOnEnd',
  'meetingSummaryTarget',
] as const;

export function profileSettingsUpdateParameters(
  input: ProfileSettingsUpdateInput,
): ControlPlanParameters {
  return {
    ...profilePreferencesUpdateParameters(input),
    meetingEnabled: input.meeting.enabled,
    meetingAutoJoinOnInvite: input.meeting.autoJoinOnInvite,
    meetingTranscriptKeep: input.meeting.transcript.keep,
    meetingTranscriptStabilizeMs: input.meeting.transcript.stabilizeMs,
    meetingRespondIn: input.meeting.respondIn,
    meetingTrigger: input.meeting.trigger,
    meetingPollIntervalMs: input.meeting.pollIntervalMs,
    meetingSummaryOnEnd: input.meeting.summaryOnEnd,
    meetingSummaryTarget: input.meeting.summaryTarget,
  };
}

export const profileSettingsUpdateCommand = command(
  PROFILE_SETTINGS_UPDATE_COMMAND,
  'live',
);

export const profileSettingsReconnectCommand = command(
  PROFILE_SETTINGS_RECONNECT_COMMAND,
  'reconnect',
);

function command(
  id: string,
  effect: 'live' | 'reconnect',
): ManagementCommandDefinition {
  return {
    id,
    version: 1,
    risk: 'low',
    effect,
    prepare({ root, profile, parameters }) {
      assertExactKeys(parameters);
      const current = root.profiles[profile];
      if (!current) {
        throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
      }
      const meeting = parseMeeting(parameters);
      if (effect === 'live' && meeting.enabled !== current.meeting.enabled) {
        throw new ControlChangeError(
          'invalid-plan',
          'meeting.enabled changes require profile.settings.update-reconnect',
        );
      }

      const prepared = profilePreferencesUpdateCommand.prepare({
        root,
        profile,
        parameters: preferenceParameters(parameters),
      });
      const before = current.meeting;
      prepared.root.profiles[profile]!.meeting = meeting;
      prepared.changes.push(...meetingChanges(before, meeting));
      return prepared;
    },
  };
}

function preferenceParameters(parameters: ControlPlanParameters): ControlPlanParameters {
  return Object.fromEntries(
    PREFERENCE_PARAMETER_KEYS.map((key) => [key, parameters[key]!]),
  );
}

function parseMeeting(parameters: ControlPlanParameters): MeetingConfig {
  return {
    enabled: booleanValue(parameters.meetingEnabled, 'meetingEnabled'),
    autoJoinOnInvite: booleanValue(
      parameters.meetingAutoJoinOnInvite,
      'meetingAutoJoinOnInvite',
    ),
    transcript: {
      keep: integerValue(parameters.meetingTranscriptKeep, 10, 2000, 'meetingTranscriptKeep'),
      stabilizeMs: integerValue(
        parameters.meetingTranscriptStabilizeMs,
        0,
        30_000,
        'meetingTranscriptStabilizeMs',
      ),
    },
    respondIn: enumValue(
      parameters.meetingRespondIn,
      ['meeting', 'im', 'both'] as const,
      'meetingRespondIn',
    ),
    trigger: nonEmptyString(parameters.meetingTrigger, 'meetingTrigger'),
    pollIntervalMs: integerValue(
      parameters.meetingPollIntervalMs,
      1000,
      60_000,
      'meetingPollIntervalMs',
    ),
    summaryOnEnd: booleanValue(parameters.meetingSummaryOnEnd, 'meetingSummaryOnEnd'),
    summaryTarget: enumValue(
      parameters.meetingSummaryTarget,
      ['origin', 'owner'] as const,
      'meetingSummaryTarget',
    ),
  };
}

function meetingChanges(before: MeetingConfig, after: MeetingConfig): ControlChangeSummary[] {
  return [
    summary('meeting.enabled', before.enabled, after.enabled),
    summary('meeting.autoJoinOnInvite', before.autoJoinOnInvite, after.autoJoinOnInvite),
    summary('meeting.transcript.keep', before.transcript.keep, after.transcript.keep),
    summary(
      'meeting.transcript.stabilizeMs',
      before.transcript.stabilizeMs,
      after.transcript.stabilizeMs,
    ),
    summary('meeting.respondIn', before.respondIn, after.respondIn),
    summary('meeting.trigger', before.trigger, after.trigger),
    summary('meeting.pollIntervalMs', before.pollIntervalMs, after.pollIntervalMs),
    summary('meeting.summaryOnEnd', before.summaryOnEnd, after.summaryOnEnd),
    summary('meeting.summaryTarget', before.summaryTarget, after.summaryTarget),
  ];
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

function nonEmptyString(value: ControlPlanScalar | undefined, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ControlChangeError('invalid-plan', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function summary(
  field: string,
  before: ControlPlanScalar,
  after: ControlPlanScalar,
): ControlChangeSummary {
  return { field, before, after };
}
