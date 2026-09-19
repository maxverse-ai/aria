import {
  BUILT_IN_LARK_PLUGIN_ID,
  SCHEMA_V2_LARK_INSTANCE_ID,
} from '../../channel/instance-resolver';
import type { ChannelConfig } from '../../channel/plugin/types';
import {
  assertChannelInstanceRef,
  assertChannelPluginPackageName,
  assertChannelPluginPackageVersion,
  assertResolvedChannelInstance,
} from '../../channel/plugin/validation';
import type {
  ProfileChannelsConfig,
  StoredChannelInstance,
  StoredChannelInstanceAuth,
} from '../../config/profile-schema';
import {
  ControlChangeError,
  type ControlChangeSummary,
  type ControlPlanParameters,
  type ControlPlanScalar,
  type ManagementCommandDefinition,
} from './change-types';

export const CHANNEL_PLUGIN_PIN_COMMAND = 'channel.plugin.pin';
export const CHANNEL_INSTANCE_CONFIGURE_COMMAND = 'channel.instance.configure';
export const CHANNEL_INSTANCE_ENABLE_COMMAND = 'channel.instance.enable';
export const CHANNEL_INSTANCE_DISABLE_COMMAND = 'channel.instance.disable';
export const CHANNEL_INSTANCE_LOGIN_COMMAND = 'channel.instance.login';
export const CHANNEL_INSTANCE_LOGOUT_COMMAND = 'channel.instance.logout';

export interface ChannelInstanceConfigureInput {
  instanceId: string;
  pluginId: string;
  configVersion: number;
  config: ChannelConfig;
  secretRefs: StoredChannelInstance['secretRefs'];
}

export function channelInstanceConfigureParameters(
  input: ChannelInstanceConfigureInput,
): ControlPlanParameters {
  return {
    instanceId: input.instanceId,
    pluginId: input.pluginId,
    configVersion: input.configVersion,
    configJson: JSON.stringify(input.config),
    secretRefsJson: JSON.stringify(input.secretRefs),
  };
}

export function channelInstanceIdParameters(instanceId: string): ControlPlanParameters {
  return { instanceId };
}

export function channelAuthParameters(
  instanceId: string,
  requestedAt: string,
): ControlPlanParameters {
  return { instanceId, requestedAt };
}

/** Desired-state pin changes stay separate from every instance command. */
export const channelPluginPinCommand: ManagementCommandDefinition = {
  id: CHANNEL_PLUGIN_PIN_COMMAND,
  version: 1,
  risk: 'low',
  effect: 'reconnect',
  prepare({ root, profile, parameters }) {
    const packageName = stringValue(parameters.package, 'package');
    const version = stringValue(parameters.version, 'version');
    assertChannelPluginPackageName(packageName);
    assertChannelPluginPackageVersion(version);
    const channels = channelsSection(root.profiles[profile], profile);
    const existing = channels.plugins.find((pin) => pin.package === packageName);
    if (existing && existing.version === version) {
      throw new ControlChangeError(
        'invalid-plan',
        `channel plugin package is already pinned: ${packageName}@${version}`,
      );
    }
    const plugins = [
      ...channels.plugins.filter((pin) => pin.package !== packageName),
      Object.freeze({ package: packageName, version }),
    ].sort((a, b) => a.package.localeCompare(b.package));
    const next = cloneChannels(channels);
    next.plugins = Object.freeze(plugins);
    root.profiles[profile]!.channels = next;
    return {
      root,
      changes: [
        {
          field: `channels.plugins.${packageName}`,
          before: existing?.version ?? null,
          after: version,
        },
      ],
    };
  },
};

export const channelInstanceConfigureCommand: ManagementCommandDefinition = {
  id: CHANNEL_INSTANCE_CONFIGURE_COMMAND,
  version: 1,
  risk: 'sensitive',
  effect: 'reconnect',
  parameterPrivacy: 'private-identifiers',
  prepare({ root, profile, parameters }) {
    const instanceId = stringValue(parameters.instanceId, 'instanceId');
    const pluginId = stringValue(parameters.pluginId, 'pluginId');
    const configVersion = positiveInteger(parameters.configVersion, 'configVersion');
    const config = jsonRecord(parameters.configJson, 'configJson');
    const secretRefs = jsonRecord(parameters.secretRefsJson, 'secretRefsJson');
    const channels = channelsSection(root.profiles[profile], profile);
    const current = channels.instances[instanceId];
    assertConfigurableInstance(instanceId, pluginId, current);
    const candidate = {
      profileId: profile,
      pluginId,
      instanceId,
      enabled: current?.enabled ?? false,
      configVersion,
      config,
      secretRefs,
      ...(current?.auth ? { auth: current.auth } : {}),
    };
    try {
      assertResolvedChannelInstance(candidate);
    } catch (error) {
      throw invalidPlan(
        `channel instance payload failed validation: ${(error as Error).message}`,
      );
    }
    const next = cloneChannels(channels);
    next.instances = Object.freeze({
      ...next.instances,
      [instanceId]: Object.freeze({
        plugin: pluginId,
        enabled: candidate.enabled,
        configVersion,
        config: Object.freeze(structuredClone(config)),
        secretRefs: Object.freeze(structuredClone(secretRefs)),
        ...(current?.auth ? { auth: current.auth } : {}),
      } as StoredChannelInstance),
    });
    root.profiles[profile]!.channels = next;
    return {
      root,
      changes: [
        {
          field: `channels.instances.${instanceId}.plugin`,
          before: current?.plugin ?? null,
          after: pluginId,
        },
        {
          field: `channels.instances.${instanceId}.configVersion`,
          before: current?.configVersion ?? null,
          after: configVersion,
        },
        {
          field: `channels.instances.${instanceId}.secretRefCount`,
          before: current ? Object.keys(current.secretRefs).length : null,
          after: Object.keys(secretRefs).length,
        },
      ],
    };
  },
};

export const channelInstanceEnableCommand = enableCommand(
  CHANNEL_INSTANCE_ENABLE_COMMAND,
  true,
);
export const channelInstanceDisableCommand = enableCommand(
  CHANNEL_INSTANCE_DISABLE_COMMAND,
  false,
);

export const channelInstanceLoginCommand = authCommand(
  CHANNEL_INSTANCE_LOGIN_COMMAND,
  'login',
);
export const channelInstanceLogoutCommand = authCommand(
  CHANNEL_INSTANCE_LOGOUT_COMMAND,
  'logout',
);

function enableCommand(id: string, enabled: boolean): ManagementCommandDefinition {
  return {
    id,
    version: 1,
    risk: enabled ? 'sensitive' : 'low',
    effect: 'reconnect',
    prepare({ root, profile, parameters }) {
      const instanceId = stringValue(parameters.instanceId, 'instanceId');
      const channels = channelsSection(root.profiles[profile], profile);
      const current = channels.instances[instanceId];
      if (!current) {
        throw new ControlChangeError(
          'invalid-plan',
          `channel instance does not exist: ${instanceId}`,
        );
      }
      if (isPrimaryLark(current.plugin, instanceId)) {
        throw new ControlChangeError(
          'invalid-plan',
          'the lark-primary instance is bound to legacy app credentials until the management cutover',
        );
      }
      if (current.enabled === enabled) {
        throw new ControlChangeError(
          'invalid-plan',
          `channel instance is already ${enabled ? 'enabled' : 'disabled'}: ${instanceId}`,
        );
      }
      const next = cloneChannels(channels);
      next.instances = Object.freeze({
        ...next.instances,
        [instanceId]: Object.freeze({ ...current, enabled }),
      });
      root.profiles[profile]!.channels = next;
      return {
        root,
        changes: [
          {
            field: `channels.instances.${instanceId}.enabled`,
            before: current.enabled,
            after: enabled,
          },
        ],
      };
    },
  };
}

function authCommand(
  id: string,
  intent: StoredChannelInstanceAuth['intent'],
): ManagementCommandDefinition {
  return {
    id,
    version: 1,
    risk: intent === 'login' ? 'sensitive' : 'low',
    effect: 'reconnect',
    prepare({ root, profile, parameters }) {
      const instanceId = stringValue(parameters.instanceId, 'instanceId');
      const requestedAt = stringValue(parameters.requestedAt, 'requestedAt');
      const channels = channelsSection(root.profiles[profile], profile);
      const current = channels.instances[instanceId];
      if (!current) {
        throw new ControlChangeError(
          'invalid-plan',
          `channel instance does not exist: ${instanceId}`,
        );
      }
      if (isBuiltIn(current.plugin)) {
        throw new ControlChangeError(
          'invalid-plan',
          `auth intent is only valid for external channel plugins: ${current.plugin}`,
        );
      }
      if (intent === 'login' && !current.enabled) {
        throw new ControlChangeError(
          'invalid-plan',
          `cannot record a login intent for a disabled channel instance: ${instanceId}`,
        );
      }
      if (current.auth?.intent === intent) {
        throw new ControlChangeError(
          'invalid-plan',
          `channel instance already holds a ${intent} intent: ${instanceId}`,
        );
      }
      const auth: StoredChannelInstanceAuth = { intent, requestedAt };
      const next = cloneChannels(channels);
      next.instances = Object.freeze({
        ...next.instances,
        [instanceId]: Object.freeze({ ...current, auth }),
      });
      root.profiles[profile]!.channels = next;
      return {
        root,
        changes: [
          {
            field: `channels.instances.${instanceId}.auth.intent`,
            before: current.auth?.intent ?? null,
            after: intent,
          },
        ],
      };
    },
  };
}

function channelsSection(
  profileConfig: { schemaVersion?: unknown; channels?: ProfileChannelsConfig } | undefined,
  profile: string,
): ProfileChannelsConfig {
  if (!profileConfig) {
    throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
  }
  if (profileConfig.schemaVersion !== 3 || !profileConfig.channels) {
    throw new ControlChangeError(
      'operation-unavailable',
      `channel desired state requires a schema v3 profile: ${profile}`,
    );
  }
  return profileConfig.channels;
}

function assertConfigurableInstance(
  instanceId: string,
  pluginId: string,
  current: StoredChannelInstance | undefined,
): void {
  assertChannelInstanceRef({ profileId: 'profile', pluginId, instanceId });
  if (pluginId === BUILT_IN_LARK_PLUGIN_ID) {
    throw new ControlChangeError(
      'invalid-plan',
      'the lark-primary instance is bound to legacy app credentials until the management cutover',
    );
  }
  if (current && current.plugin !== pluginId) {
    throw new ControlChangeError(
      'invalid-plan',
      `channel instance plugin cannot change in place: ${instanceId}`,
    );
  }
}

function isPrimaryLark(pluginId: string, instanceId: string): boolean {
  return pluginId === BUILT_IN_LARK_PLUGIN_ID && instanceId === SCHEMA_V2_LARK_INSTANCE_ID;
}

function isBuiltIn(pluginId: string): boolean {
  return pluginId === BUILT_IN_LARK_PLUGIN_ID || pluginId === 'wechat-kf';
}

function cloneChannels(channels: ProfileChannelsConfig): {
  plugins: ProfileChannelsConfig['plugins'];
  instances: Record<string, StoredChannelInstance>;
} {
  return {
    plugins: channels.plugins,
    instances: { ...channels.instances },
  };
}

function stringValue(value: ControlPlanScalar | undefined, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ControlChangeError('invalid-plan', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value: ControlPlanScalar | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ControlChangeError('invalid-plan', `${field} must be a positive integer`);
  }
  return value;
}

function jsonRecord(value: ControlPlanScalar | undefined, field: string): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new ControlChangeError('invalid-plan', `${field} must be a JSON object string`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ControlChangeError('invalid-plan', `${field} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ControlChangeError('invalid-plan', `${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function invalidPlan(message: string): ControlChangeError {
  return new ControlChangeError('invalid-plan', message);
}
