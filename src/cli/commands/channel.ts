import { randomUUID } from 'node:crypto';
import {
  authorizeAdapterCommands,
  channelAuthParameters,
  channelInstanceConfigureParameters,
  channelInstanceIdParameters,
  CHANNEL_INSTANCE_CONFIGURE_COMMAND,
  CHANNEL_INSTANCE_ENABLE_COMMAND,
  CHANNEL_INSTANCE_LOGIN_COMMAND,
  CHANNEL_PLUGIN_PIN_COMMAND,
  CHANNEL_INSTANCE_DISABLE_COMMAND,
  CHANNEL_INSTANCE_LOGOUT_COMMAND,
  ConfigChangeService,
  diagnoseChannels,
  getChannelStatus,
  listChannelInstances,
  MANAGEMENT_API_VERSION,
  ManagementApi,
  managementCommandRegistry,
  type ChannelDiagnostic,
  type ChannelInstanceProjection,
  type ChannelQueryInput,
  type ChannelStatusSnapshot,
  type ControlActorContext,
  type ControlPlanParameters,
} from '../../application/control';
import { projectProfileChannelInstances } from '../../channel/instance-resolver';
import { resolveAppPaths } from '../../config/app-paths';
import { paths } from '../../config/paths';
import { loadRootConfig, readActiveProfileProjection } from '../../config/profile-store';
import { localCliActor } from '../control-actor';
import { formatPlan, LOCAL_CLI_ELEVATED_COMMANDS } from './config-change';

export interface ChannelCliOptions {
  profile?: string;
  json?: boolean;
  rootDir?: string;
  actor?: ControlActorContext;
}

export interface ChannelConfigureCliOptions extends ChannelCliOptions {
  plugin: string;
  configVersion: number;
  config: string;
  secretRefs?: string;
}

/**
 * A standalone CLI process cannot see another process's runtime snapshots, so
 * runtime/health sources stay empty here; desired state is still exact.
 */
async function channelQuery(opts: ChannelCliOptions): Promise<ChannelQueryInput> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const profile = opts.profile ?? (await readActiveProfileProjection(rootDir));
  if (!profile) throw new Error('no active profile; pass --profile');
  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile);
  const profileConfig = root?.profiles[profile];
  if (!profileConfig) throw new Error(`profile not found: ${profile}`);
  return {
    profileId: profile,
    instances: projectProfileChannelInstances({ profileId: profile, profile: profileConfig }),
    declaredPackages: profileConfig.channels?.plugins,
  };
}

export async function runChannelList(opts: ChannelCliOptions = {}): Promise<void> {
  const instances = listChannelInstances(await channelQuery(opts));
  print(instances, opts.json, formatInstanceList);
}

export async function runChannelStatus(opts: ChannelCliOptions = {}): Promise<void> {
  const status = getChannelStatus(await channelQuery(opts));
  print(status, opts.json, formatStatus);
}

export async function runChannelDiagnose(opts: ChannelCliOptions = {}): Promise<void> {
  const diagnostics = diagnoseChannels(await channelQuery(opts));
  print(diagnostics, opts.json, formatDiagnostics);
}

export async function runChannelPin(
  packageName: string,
  version: string,
  opts: ChannelCliOptions = {},
): Promise<void> {
  await planChannelCommand(CHANNEL_PLUGIN_PIN_COMMAND, { package: packageName, version }, opts);
}

export async function runChannelConfigure(
  instanceId: string,
  opts: ChannelConfigureCliOptions,
): Promise<void> {
  await planChannelCommand(
    CHANNEL_INSTANCE_CONFIGURE_COMMAND,
    channelInstanceConfigureParameters({
      instanceId,
      pluginId: opts.plugin,
      configVersion: opts.configVersion,
      config: JSON.parse(opts.config),
      secretRefs: JSON.parse(opts.secretRefs ?? '{}'),
    }),
    opts,
  );
}

export async function runChannelEnable(instanceId: string, opts: ChannelCliOptions = {}): Promise<void> {
  await planChannelCommand(CHANNEL_INSTANCE_ENABLE_COMMAND, channelInstanceIdParameters(instanceId), opts);
}

export async function runChannelDisable(instanceId: string, opts: ChannelCliOptions = {}): Promise<void> {
  await planChannelCommand(CHANNEL_INSTANCE_DISABLE_COMMAND, channelInstanceIdParameters(instanceId), opts);
}

export async function runChannelLogin(instanceId: string, opts: ChannelCliOptions = {}): Promise<void> {
  await planChannelCommand(
    CHANNEL_INSTANCE_LOGIN_COMMAND,
    channelAuthParameters(instanceId, new Date().toISOString()),
    opts,
  );
}

export async function runChannelLogout(instanceId: string, opts: ChannelCliOptions = {}): Promise<void> {
  await planChannelCommand(
    CHANNEL_INSTANCE_LOGOUT_COMMAND,
    channelAuthParameters(instanceId, new Date().toISOString()),
    opts,
  );
}

async function planChannelCommand(
  command: string,
  parameters: ControlPlanParameters,
  opts: ChannelCliOptions,
): Promise<void> {
  const profile = opts.profile ?? (await readActiveProfileProjection(opts.rootDir ?? paths.rootDir));
  if (!profile) throw new Error('no active profile; pass --profile');
  const { plan } = await channelManagementApi(opts).plan({
    schema: 'aria.management.plan.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    profile,
    command,
    input: parameters,
    actor: opts.actor ?? localCliActor(opts.rootDir ?? paths.rootDir),
  });
  print(plan, opts.json, formatPlan);
  process.stderr.write(
    `plan ${plan.id} created; run \`aria config confirm ${plan.id}\` then \`aria config apply ${plan.id}\` to commit\n`,
  );
}

export function channelManagementApi(
  opts: Pick<ChannelCliOptions, 'rootDir'>,
): ManagementApi {
  return new ManagementApi(
    new ConfigChangeService({
      rootDir: opts.rootDir ?? paths.rootDir,
      registry: managementCommandRegistry,
      authorizeCommand: authorizeAdapterCommands('local-cli', LOCAL_CLI_ELEVATED_COMMANDS),
    }),
  );
}

function formatInstanceList(instances: readonly ChannelInstanceProjection[]): string {
  if (instances.length === 0) return 'no channel instances';
  return instances
    .map(
      (instance) =>
        `- ${instance.instanceId} · ${instance.pluginId} [${instance.origin}] · ${instance.state}` +
        `${instance.desired.enabled ? '' : ' (disabled)'}` +
        (instance.errorCode ? ` · ${instance.errorCode}` : ''),
    )
    .join('\n');
}

function formatStatus(status: ChannelStatusSnapshot): string {
  const lines = [
    `Aria channels · ${status.profileId}`,
    `plugins: ${status.plugins.length === 0 ? 'none' : ''}`,
    ...status.plugins.map(
      (plugin) =>
        `- ${plugin.package}@${plugin.version} · declared ${plugin.declared ? 'yes' : 'no'} · loaded ${plugin.loaded ? 'yes' : 'no'}`,
    ),
    'instances:',
    ...status.instances.map(
      (instance) =>
        `- ${instance.instanceId} · ${instance.pluginId} [${instance.origin}] · ${instance.state}` +
        ` · in-flight ${instance.inFlightInbound}in/${instance.inFlightOutbound}out` +
        (instance.errorCode ? ` · ${instance.errorCode}` : ''),
    ),
  ];
  return lines.join('\n');
}

function formatDiagnostics(diagnostics: readonly ChannelDiagnostic[]): string {
  if (diagnostics.length === 0) return 'no channel diagnostics';
  return diagnostics
    .map(
      (item) =>
        `- [${item.severity}] ${item.code}` +
        (item.instanceId ? ` · ${item.instanceId}` : ''),
    )
    .join('\n');
}

function print<T>(value: T, json: boolean | undefined, format: (value: T) => string): void {
  console.log(json ? JSON.stringify(value, null, 2) : format(value));
}
