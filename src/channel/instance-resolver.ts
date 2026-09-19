import { isDeepStrictEqual } from 'node:util';
import type {
  ProfileChannelsConfig,
  ProfileConfig,
} from '../config/profile-schema';
import {
  isSecretRef,
  type AppCredentials,
  type SecretRef,
  type TenantBrand,
} from '../config/schema';
import { ChannelPluginError } from './plugin/errors';
import type {
  ChannelConfig,
  ResolvedChannelInstance,
} from './plugin/types';
import { assertResolvedChannelInstance } from './plugin/validation';

export const BUILT_IN_LARK_PLUGIN_ID = 'lark' as const;
export const SCHEMA_V2_LARK_INSTANCE_ID = 'lark-primary' as const;
export const BUILT_IN_LARK_CONFIG_VERSION = 1 as const;

export type LarkCredentialMode =
  | 'secret-ref'
  | 'env-template'
  | 'legacy-inline';

export interface LarkChannelConfig extends ChannelConfig {
  appId: string;
  tenant: TenantBrand;
  credentialMode: LarkCredentialMode;
}

export interface SchemaV2ChannelProjectionInput {
  profileId: string;
  profile: {
    schemaVersion: ProfileConfig['schemaVersion'];
    accounts: {
      app: AppCredentials;
    };
  };
}

export interface SchemaV3ChannelProjectionInput {
  profileId: string;
  profile: {
    schemaVersion: ProfileConfig['schemaVersion'];
    accounts: {
      app: AppCredentials;
    };
    channels?: ProfileChannelsConfig;
  };
}

export type ProfileChannelProjectionInput = SchemaV3ChannelProjectionInput;

export type SchemaV2ChannelInstances = readonly [
  ResolvedChannelInstance<LarkChannelConfig>,
];

export type SchemaV3ChannelInstances = readonly ResolvedChannelInstance[];

/**
 * Pure compatibility projection from the authoritative schema-v2 profile into
 * the future channel-instance model. It never resolves credentials or writes
 * configuration. The existing production Lark path remains the lifecycle
 * authority until its later opt-in migration stage.
 */
export function projectSchemaV2ChannelInstances(
  input: SchemaV2ChannelProjectionInput,
): SchemaV2ChannelInstances {
  if (input.profile.schemaVersion !== 2) {
    throw new ChannelPluginError('unsupported profile schema for channel projection', {
      kind: 'configuration',
      code: 'unsupported-channel-profile-schema',
    });
  }

  const { mode, ref } = projectCredential(input.profile.accounts.app.secret);
  const projectedSecretRefs: Record<string, SecretRef> = {};
  if (ref) projectedSecretRefs.appSecret = ref;
  const secretRefs: Readonly<Record<string, SecretRef>> =
    Object.freeze(projectedSecretRefs);
  const instance: ResolvedChannelInstance<LarkChannelConfig> = {
    profileId: input.profileId,
    pluginId: BUILT_IN_LARK_PLUGIN_ID,
    instanceId: SCHEMA_V2_LARK_INSTANCE_ID,
    enabled: true,
    configVersion: BUILT_IN_LARK_CONFIG_VERSION,
    config: Object.freeze({
      appId: input.profile.accounts.app.id,
      tenant: input.profile.accounts.app.tenant,
      credentialMode: mode,
    }),
    secretRefs,
  };
  assertResolvedChannelInstance(instance);
  return Object.freeze([Object.freeze(instance)]) as SchemaV2ChannelInstances;
}

/** Project either supported stored profile schema without mutating it. */
export function projectProfileChannelInstances(
  input: ProfileChannelProjectionInput,
): SchemaV3ChannelInstances {
  if (input.profile.schemaVersion === 2) {
    return projectSchemaV2ChannelInstances(input as SchemaV2ChannelProjectionInput);
  }
  if (input.profile.schemaVersion !== 3 || !input.profile.channels) {
    throw new ChannelPluginError('unsupported profile schema for channel projection', {
      kind: 'configuration',
      code: 'unsupported-channel-profile-schema',
    });
  }

  const instances = Object.entries(input.profile.channels.instances)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([instanceId, stored]) => {
      const instance: ResolvedChannelInstance = {
        profileId: input.profileId,
        pluginId: stored.plugin,
        instanceId,
        enabled: stored.enabled,
        configVersion: stored.configVersion,
        config: deepFreeze(structuredClone(stored.config)),
        secretRefs: deepFreeze(structuredClone(stored.secretRefs)),
        ...(stored.auth
          ? { auth: deepFreeze(structuredClone(stored.auth)) }
          : {}),
      };
      assertResolvedChannelInstance(instance);
      return Object.freeze(instance);
    });
  requirePrimaryLarkChannelInstance(instances, input.profile.accounts.app);
  return Object.freeze(instances);
}

/**
 * Stage 8 keeps the proven Lark transport on legacy account credentials. The
 * v3 record must therefore describe that exact same binding until the later
 * management cutover removes this compatibility seam.
 */
export function requirePrimaryLarkChannelInstance(
  instances: readonly ResolvedChannelInstance[],
  app: AppCredentials,
): ResolvedChannelInstance<LarkChannelConfig> {
  const matches = instances.filter((instance) => instance.pluginId === BUILT_IN_LARK_PLUGIN_ID);
  if (matches.length !== 1 || matches[0]?.instanceId !== SCHEMA_V2_LARK_INSTANCE_ID) {
    throw new ChannelPluginError('schema v3 requires exactly one lark-primary instance', {
      kind: 'configuration',
      code: 'invalid-primary-lark-instance',
    });
  }
  const instance = matches[0];
  const config = instance.config as Partial<LarkChannelConfig>;
  const projectedCredential = projectCredential(app.secret);
  const projectedSecretRefs = projectedCredential.ref
    ? { appSecret: projectedCredential.ref }
    : {};
  if (
    instance.configVersion !== BUILT_IN_LARK_CONFIG_VERSION ||
    instance.enabled !== true ||
    config.appId !== app.id ||
    config.tenant !== app.tenant ||
    config.credentialMode !== projectedCredential.mode ||
    !isDeepStrictEqual(instance.secretRefs, projectedSecretRefs)
  ) {
    throw new ChannelPluginError('schema v3 lark-primary does not match legacy Lark binding', {
      kind: 'configuration',
      code: 'lark-channel-binding-mismatch',
    });
  }
  return instance as ResolvedChannelInstance<LarkChannelConfig>;
}

/** Build the canonical v3 channel section for one schema-v2 profile. */
export function createSchemaV3ChannelsFromSchemaV2Profile(input: {
  profileId: string;
  profile: SchemaV2ChannelProjectionInput['profile'];
}): ProfileChannelsConfig {
  const [lark] = projectSchemaV2ChannelInstances(input);
  return Object.freeze({
    plugins: Object.freeze([]),
    instances: Object.freeze({
      [lark.instanceId]: Object.freeze({
        plugin: lark.pluginId,
        enabled: lark.enabled,
        configVersion: lark.configVersion,
        config: lark.config,
        secretRefs: lark.secretRefs,
      }),
    }),
  });
}

function projectCredential(secret: AppCredentials['secret']): {
  mode: LarkCredentialMode;
  ref?: Readonly<SecretRef>;
} {
  if (typeof secret === 'string') {
    const env = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/.exec(secret);
    if (env) {
      return {
        mode: 'env-template',
        ref: Object.freeze({ source: 'env', id: env[1] as string }),
      };
    }
    return { mode: 'legacy-inline' };
  }
  if (!isSecretRef(secret)) {
    throw new ChannelPluginError('invalid Lark credential binding', {
      kind: 'configuration',
      code: 'invalid-lark-credential-binding',
    });
  }
  return {
    mode: 'secret-ref',
    ref: Object.freeze({
      source: secret.source,
      id: secret.id,
      ...(secret.provider !== undefined ? { provider: secret.provider } : {}),
    }),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach((item) => deepFreeze(item));
  }
  return value;
}
