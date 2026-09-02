import type { ProfileConfig } from '../config/profile-schema';
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

export type SchemaV2ChannelInstances = readonly [
  ResolvedChannelInstance<LarkChannelConfig>,
];

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
