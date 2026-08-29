import type { ProfileAccess } from '../../config/profile-schema';
import {
  ControlChangeError,
  type ControlChangeSummary,
  type ControlPlanParameters,
  type ControlPlanScalar,
  type ManagementCommandDefinition,
} from './change-types';

export const PROFILE_ACCESS_UPDATE_COMMAND = 'profile.access.update';

export type ProfileAccessKind = 'user' | 'admin' | 'chat';
export type ProfileAccessAction = 'add' | 'remove' | 'set-mention';

export interface ProfileAccessUpdateInput {
  action: ProfileAccessAction;
  kind: ProfileAccessKind;
  targets: readonly string[];
  requireMention?: boolean | null;
}

const PARAMETER_KEYS = ['action', 'kind', 'targets', 'requireMention'] as const;

export function profileAccessUpdateParameters(
  input: ProfileAccessUpdateInput,
): ControlPlanParameters {
  return {
    action: input.action,
    kind: input.kind,
    targets: JSON.stringify(input.targets),
    requireMention: input.requireMention ?? null,
  };
}

export const profileAccessUpdateCommand: ManagementCommandDefinition = {
  id: PROFILE_ACCESS_UPDATE_COMMAND,
  version: 1,
  risk: 'sensitive',
  effect: 'live',
  parameterPrivacy: 'private-identifiers',
  prepare({ root, profile, parameters }) {
    assertExactKeys(parameters);
    const current = root.profiles[profile];
    if (!current) {
      throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
    }
    const input = parseInput(parameters);
    const before = current.access;
    const after = applyProfileAccessUpdate(before, input);
    current.access = after;
    return { root, changes: accessChanges(before, after, input) };
  },
};

export function applyProfileAccessUpdate(
  current: ProfileAccess,
  input: ProfileAccessUpdateInput,
): ProfileAccess {
  const targets = normalizeTargets(input.targets);
  if (input.action === 'set-mention') {
    if (input.kind !== 'chat' || targets.length !== 1) {
      throw new ControlChangeError(
        'invalid-plan',
        'set-mention requires exactly one chat target',
      );
    }
    if (input.requireMention !== null && typeof input.requireMention !== 'boolean') {
      throw new ControlChangeError('invalid-plan', 'set-mention requires boolean or null');
    }
    const map = { ...(current.chatRequireMention ?? {}) };
    if (input.requireMention === null) delete map[targets[0]!];
    else map[targets[0]!] = input.requireMention;
    const next: ProfileAccess = { ...current, chatRequireMention: map };
    if (Object.keys(map).length === 0) delete next.chatRequireMention;
    return next;
  }

  if (input.requireMention !== undefined && input.requireMention !== null) {
    throw new ControlChangeError('invalid-plan', 'requireMention is only valid for set-mention');
  }
  const key = accessListKey(input.kind);
  const values = new Set(current[key]);
  for (const target of targets) {
    if (input.action === 'add') values.add(target);
    else values.delete(target);
  }
  const next: ProfileAccess = { ...current, [key]: [...values] };
  if (input.action === 'remove' && input.kind === 'chat' && next.chatRequireMention) {
    const map = { ...next.chatRequireMention };
    for (const target of targets) delete map[target];
    if (Object.keys(map).length > 0) next.chatRequireMention = map;
    else delete next.chatRequireMention;
  }
  return next;
}

function parseInput(parameters: ControlPlanParameters): ProfileAccessUpdateInput {
  const action = enumValue(
    parameters.action,
    ['add', 'remove', 'set-mention'] as const,
    'action',
  );
  const kind = enumValue(parameters.kind, ['user', 'admin', 'chat'] as const, 'kind');
  const rawTargets = stringValue(parameters.targets, 'targets');
  let targets: unknown;
  try {
    targets = JSON.parse(rawTargets);
  } catch {
    throw new ControlChangeError('invalid-plan', 'targets must be a JSON string array');
  }
  if (!Array.isArray(targets)) {
    throw new ControlChangeError('invalid-plan', 'targets must be a JSON string array');
  }
  const requireMention = parameters.requireMention;
  if (requireMention !== null && typeof requireMention !== 'boolean') {
    throw new ControlChangeError('invalid-plan', 'requireMention must be boolean or null');
  }
  return {
    action,
    kind,
    targets: normalizeTargets(targets),
    requireMention,
  };
}

function normalizeTargets(targets: readonly unknown[]): string[] {
  if (targets.length === 0 || targets.length > 1000) {
    throw new ControlChangeError('invalid-plan', 'targets must contain between 1 and 1000 ids');
  }
  const normalized = targets.map((target) => {
    if (
      typeof target !== 'string' ||
      !target.trim() ||
      target.trim().length > 256 ||
      /[\r\n\0]/.test(target)
    ) {
      throw new ControlChangeError('invalid-plan', 'every target must be a valid non-empty id');
    }
    return target.trim();
  });
  return [...new Set(normalized)];
}

function accessListKey(
  kind: ProfileAccessKind,
): 'allowedUsers' | 'admins' | 'allowedChats' {
  if (kind === 'user') return 'allowedUsers';
  if (kind === 'admin') return 'admins';
  return 'allowedChats';
}

function accessChanges(
  before: ProfileAccess,
  after: ProfileAccess,
  input: ProfileAccessUpdateInput,
): ControlChangeSummary[] {
  const changes = [
    countSummary('access.allowedUsers.count', before.allowedUsers, after.allowedUsers),
    countSummary('access.allowedChats.count', before.allowedChats, after.allowedChats),
    countSummary('access.admins.count', before.admins, after.admins),
    countSummary(
      'access.chatMentionOverrides.count',
      Object.keys(before.chatRequireMention ?? {}),
      Object.keys(after.chatRequireMention ?? {}),
    ),
  ].filter((change): change is ControlChangeSummary => Boolean(change));
  if (input.action === 'set-mention') {
    const target = input.targets[0]!;
    const previous = before.chatRequireMention?.[target] ?? null;
    const next = after.chatRequireMention?.[target] ?? null;
    if (previous !== next) {
      changes.push({ field: 'access.chatMentionOverride.value', before: previous, after: next });
    }
  }
  return changes;
}

function countSummary(
  field: string,
  before: readonly unknown[],
  after: readonly unknown[],
): ControlChangeSummary | undefined {
  return before.length === after.length
    ? undefined
    : { field, before: before.length, after: after.length };
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

function stringValue(value: ControlPlanScalar | undefined, field: string): string {
  if (typeof value !== 'string') {
    throw new ControlChangeError('invalid-plan', `${field} must be a string`);
  }
  return value;
}
