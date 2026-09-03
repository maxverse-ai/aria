import {
  normalizeProfileConfig,
  type ProfileConfig,
} from '../../config/profile-schema';
import { isSecretRef, type SecretsConfig } from '../../config/schema';
import { migrateProfileConfigToSchemaV3 } from '../../config/channel-schema-migration';
import {
  ControlChangeError,
  type ControlChangeSummary,
  type ControlPlanParameters,
  type ManagementCommandDefinition,
} from './change-types';

export const PROFILE_ACTIVATE_COMMAND = 'profile.activate';
export const PROFILE_CREATE_COMMAND = 'profile.create';
export const PROFILE_ARCHIVE_COMMAND = 'profile.archive';
export const PROFILE_PURGE_COMMAND = 'profile.purge';

export const PROFILE_LIFECYCLE_ELEVATED_COMMANDS = [
  PROFILE_CREATE_COMMAND,
  PROFILE_ARCHIVE_COMMAND,
  PROFILE_PURGE_COMMAND,
] as const;

export interface PreparedProfileDefinition {
  config: ProfileConfig;
  rootSecrets?: SecretsConfig;
}

export function profileCreateParameters(
  definition: PreparedProfileDefinition,
): ControlPlanParameters {
  return { definition: JSON.stringify(definition) };
}

/** Root-scoped desired-state transition for selecting the default profile. */
export const profileActivateCommand: ManagementCommandDefinition = {
  id: PROFILE_ACTIVATE_COMMAND,
  version: 1,
  risk: 'low',
  effect: 'none',
  resourceScope: 'root',
  prepare({ root, profile, parameters }) {
    assertNoParameters(parameters, PROFILE_ACTIVATE_COMMAND);
    if (!root.profiles[profile]) {
      throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
    }
    const before = root.activeProfile;
    root.activeProfile = profile;
    return {
      root,
      changes: [{ field: 'activeProfile', before, after: profile }],
    };
  },
};

/** Adds a fully prepared, secret-reference-only profile definition. */
export const profileCreateCommand: ManagementCommandDefinition = {
  id: PROFILE_CREATE_COMMAND,
  version: 1,
  risk: 'sensitive',
  effect: 'none',
  resourceScope: 'root',
  parameterPrivacy: 'private-identifiers',
  prepare({ root, profile, parameters }) {
    if (root.profiles[profile]) {
      throw new ControlChangeError(
        'profile-already-exists',
        `profile already exists: ${profile}`,
      );
    }
    const definition = preparedDefinition(parameters, root.secrets);
    const config = root.schemaVersion === 3 && definition.config.schemaVersion === 2
      ? migrateProfileConfigToSchemaV3(profile, definition.config)
      : structuredClone(definition.config);
    if (config.schemaVersion !== root.schemaVersion) {
      throw new ControlChangeError(
        'invalid-plan',
        `profile schemaVersion ${config.schemaVersion} does not match root schemaVersion ${root.schemaVersion}`,
      );
    }
    const incomingSecrets = definition.rootSecrets ?? config.secrets;
    delete config.secrets;
    const beforeCount = Object.keys(root.profiles).length;
    root.profiles[profile] = config;
    if (incomingSecrets) root.secrets = mergeSecrets(root.secrets, incomingSecrets);
    return {
      root,
      changes: [
        { field: 'profiles.count', before: beforeCount, after: beforeCount + 1 },
        { field: 'profile.created', before: false, after: true },
      ],
    };
  },
};

export const profileArchiveCommand = removalCommand({
  id: PROFILE_ARCHIVE_COMMAND,
  risk: 'sensitive',
  summaryField: 'profile.archived',
});

export const profilePurgeCommand = removalCommand({
  id: PROFILE_PURGE_COMMAND,
  risk: 'destructive',
  summaryField: 'profile.purged',
});

function removalCommand(input: {
  id: typeof PROFILE_ARCHIVE_COMMAND | typeof PROFILE_PURGE_COMMAND;
  risk: 'sensitive' | 'destructive';
  summaryField: 'profile.archived' | 'profile.purged';
}): ManagementCommandDefinition {
  return {
    id: input.id,
    version: 1,
    risk: input.risk,
    effect: 'none',
    resourceScope: 'root',
    allowsRootDeletion: true,
    prepare({ root, profile, parameters }) {
      assertNoParameters(parameters, input.id);
      if (!root.profiles[profile]) {
        throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
      }
      const beforeCount = Object.keys(root.profiles).length;
      const remaining = Object.keys(root.profiles)
        .filter((name) => name !== profile)
        .sort(compareProfileNames);
      const changes: ControlChangeSummary[] = [
        { field: 'profiles.count', before: beforeCount, after: remaining.length },
        { field: input.summaryField, before: false, after: true },
      ];
      if (remaining.length === 0) {
        changes.push({ field: 'root.removed', before: false, after: true });
        return { root, changes, deleteRoot: true };
      }
      const next = {
        ...root,
        profiles: { ...root.profiles },
      };
      delete next.profiles[profile];
      if (next.activeProfile === profile) {
        next.activeProfile = remaining[0]!;
        changes.push({ field: 'activeProfile.changed', before: false, after: true });
      }
      return { root: next, changes };
    },
  };
}

function compareProfileNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function preparedDefinition(
  parameters: ControlPlanParameters,
  existingRootSecrets: SecretsConfig | undefined,
): PreparedProfileDefinition {
  const keys = Object.keys(parameters);
  if (keys.length !== 1 || keys[0] !== 'definition' || typeof parameters.definition !== 'string') {
    throw new ControlChangeError('invalid-plan', 'profile.create requires a prepared definition');
  }
  if (parameters.definition.length > 256 * 1024) {
    throw new ControlChangeError('invalid-plan', 'prepared profile definition is too large');
  }
  let raw: { config?: unknown; rootSecrets?: unknown };
  try {
    raw = JSON.parse(parameters.definition) as { config?: unknown; rootSecrets?: unknown };
  } catch {
    throw new ControlChangeError('invalid-plan', 'prepared profile definition must be valid JSON');
  }
  return normalizePreparedProfileDefinition(raw, existingRootSecrets);
}

export function normalizePreparedProfileDefinition(
  raw: { config?: unknown; rootSecrets?: unknown },
  existingRootSecrets?: SecretsConfig,
): PreparedProfileDefinition {
  let config: ProfileConfig;
  try {
    config = normalizeProfileConfig(raw.config);
  } catch (error) {
    throw new ControlChangeError(
      'invalid-plan',
      `prepared profile definition is invalid: ${errorMessage(error)}`,
    );
  }
  if (!isSecretRef(config.accounts.app.secret) || config.accounts.app.secret.source !== 'exec') {
    throw new ControlChangeError(
      'invalid-plan',
      'prepared profile must reference an external app secret',
    );
  }
  const rootSecrets = optionalSecretsConfig(raw.rootSecrets ?? config.secrets);
  const effectiveSecrets = mergeSecrets(existingRootSecrets, rootSecrets);
  const provider = config.accounts.app.secret.provider;
  if (!provider || effectiveSecrets?.providers?.[provider]?.source !== 'exec') {
    throw new ControlChangeError(
      'invalid-plan',
      'prepared profile secret provider is unavailable',
    );
  }
  return {
    config,
    ...(rootSecrets ? { rootSecrets } : {}),
  };
}

function mergeSecrets(
  base: SecretsConfig | undefined,
  incoming: SecretsConfig | undefined,
): SecretsConfig | undefined {
  if (!base && !incoming) return undefined;
  return {
    ...structuredClone(base ?? {}),
    ...structuredClone(incoming ?? {}),
    ...(base?.providers || incoming?.providers
      ? {
          providers: {
            ...structuredClone(base?.providers ?? {}),
            ...structuredClone(incoming?.providers ?? {}),
          },
        }
      : {}),
    ...(base?.defaults || incoming?.defaults
      ? {
          defaults: {
            ...structuredClone(base?.defaults ?? {}),
            ...structuredClone(incoming?.defaults ?? {}),
          },
        }
      : {}),
  };
}

function optionalSecretsConfig(value: unknown): SecretsConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlChangeError('invalid-plan', 'prepared root secrets must be an object');
  }
  return structuredClone(value as SecretsConfig);
}

function assertNoParameters(parameters: ControlPlanParameters, command: string): void {
  if (Object.keys(parameters).length > 0) {
    throw new ControlChangeError('invalid-plan', `${command} does not accept parameters`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
