import { resolveAppPaths } from '../../config/app-paths';
import type { TenantBrand } from '../../config/schema';
import { secretKeyForApp } from '../../config/schema';
import { secretsGetterWrapperPath } from '../../config/store';
import {
  ControlChangeError,
  type ControlChangeSummary,
  type ControlPlanParameters,
  type ControlPlanScalar,
  type ManagementCommandDefinition,
} from './change-types';

export const PROFILE_ACCOUNT_UPDATE_COMMAND = 'profile.account.update';

export interface ProfileAccountUpdateInput {
  application: string;
  tenant: TenantBrand;
  recordedAt: string;
}

const PARAMETER_KEYS = ['application', 'tenant', 'recordedAt'] as const;

export function profileAccountUpdateParameters(
  input: ProfileAccountUpdateInput,
): ControlPlanParameters {
  return { ...input };
}

export function nextAccountRecordedAt(
  previous: string | undefined,
  now: Date = new Date(),
): string {
  const previousMs = previous ? Date.parse(previous) : Number.NaN;
  const nextMs = Number.isNaN(previousMs) ? now.getTime() : Math.max(now.getTime(), previousMs + 1);
  return new Date(nextMs).toISOString();
}

export const profileAccountUpdateCommand: ManagementCommandDefinition = {
  id: PROFILE_ACCOUNT_UPDATE_COMMAND,
  version: 1,
  risk: 'sensitive',
  effect: 'reconnect',
  parameterPrivacy: 'private-identifiers',
  prepare({ root, profile, parameters, rootDir }) {
    assertExactKeys(parameters);
    const current = root.profiles[profile];
    if (!current) {
      throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
    }
    if (!rootDir) throw new ControlChangeError('invalid-plan', 'rootDir is required');
    const application = applicationValue(parameters.application);
    const tenant = enumValue(parameters.tenant, ['feishu', 'lark'] as const, 'tenant');
    const recordedAt = timestampValue(parameters.recordedAt, 'recordedAt');
    const before = current.accounts;
    if (
      before.recordedAt &&
      Date.parse(recordedAt) <= Date.parse(before.recordedAt)
    ) {
      throw new ControlChangeError('invalid-plan', 'recordedAt must advance monotonically');
    }
    const inheritedSecrets = current.secrets ?? root.secrets ?? {};
    const providerCommand = secretsGetterWrapperPath(
      resolveAppPaths({ rootDir, profile }),
    );

    current.accounts = {
      app: {
        id: application,
        tenant,
        secret: {
          source: 'exec',
          provider: 'bridge',
          id: secretKeyForApp(application),
        },
      },
      recordedAt,
    };
    current.secrets = {
      ...inheritedSecrets,
      providers: {
        ...(inheritedSecrets.providers ?? {}),
        bridge: {
          source: 'exec',
          command: providerCommand,
          args: [],
        },
      },
    };
    return { root, changes: accountChanges(before, current.accounts) };
  },
};

function accountChanges(
  before: { app: { id: string; tenant: TenantBrand }; recordedAt?: string },
  after: { app: { id: string; tenant: TenantBrand }; recordedAt?: string },
): ControlChangeSummary[] {
  const changes: ControlChangeSummary[] = [];
  if (before.app.id !== after.app.id) {
    changes.push({ field: 'account.applicationChanged', before: false, after: true });
  }
  if (before.app.tenant !== after.app.tenant) {
    changes.push({ field: 'account.tenant', before: before.app.tenant, after: after.app.tenant });
  }
  if (before.recordedAt !== after.recordedAt) {
    changes.push({
      field: 'account.recordedAt',
      before: before.recordedAt ?? null,
      after: after.recordedAt ?? null,
    });
  }
  return changes;
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

function applicationValue(value: ControlPlanScalar | undefined): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 256 ||
    !/^[A-Za-z0-9._:-]+$/.test(value.trim())
  ) {
    throw new ControlChangeError('invalid-plan', 'application must be a valid identifier');
  }
  return value.trim();
}

function timestampValue(value: ControlPlanScalar | undefined, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ControlChangeError('invalid-plan', `${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
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
