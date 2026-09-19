import { randomUUID } from 'node:crypto';
import {
  authorizeAdapterCommands,
  CHANNEL_INSTANCE_CONFIGURE_COMMAND,
  CHANNEL_INSTANCE_DISABLE_COMMAND,
  CHANNEL_INSTANCE_ENABLE_COMMAND,
  CHANNEL_INSTANCE_LOGIN_COMMAND,
  CHANNEL_INSTANCE_LOGOUT_COMMAND,
  CHANNEL_PLUGIN_PIN_COMMAND,
  ConfigChangeService,
  diagnoseChannels,
  getChannelStatus,
  MANAGEMENT_API_VERSION,
  ManagementApi,
  managementCommandRegistry,
  type ChannelDiagnostic,
  type ChannelStatusSnapshot,
  type ControlActorContext,
  type ControlPlanParameters,
} from '../application/control';
import { projectProfileChannelInstances } from '../channel/instance-resolver';
import { resolveAppPaths } from '../config/app-paths';
import { loadRootConfig, readActiveProfileProjection } from '../config/profile-store';
import type { ChannelQueryInput } from '../application/control/channel-read-model';
import { HttpError } from './http';
import type { UiServerDeps } from './types';

const CHANNEL_COMMAND_IDS: ReadonlySet<string> = new Set([
  CHANNEL_PLUGIN_PIN_COMMAND,
  CHANNEL_INSTANCE_CONFIGURE_COMMAND,
  CHANNEL_INSTANCE_ENABLE_COMMAND,
  CHANNEL_INSTANCE_DISABLE_COMMAND,
  CHANNEL_INSTANCE_LOGIN_COMMAND,
  CHANNEL_INSTANCE_LOGOUT_COMMAND,
]);

/** Elevated channel commands the authenticated local console may execute. */
const WEB_CHANNEL_COMMANDS: readonly string[] = Object.freeze([
  CHANNEL_INSTANCE_CONFIGURE_COMMAND,
  CHANNEL_INSTANCE_ENABLE_COMMAND,
  CHANNEL_INSTANCE_LOGIN_COMMAND,
]);

function actor(): ControlActorContext {
  return { source: 'web', principal: 'local-console' };
}

function managementApi(deps: UiServerDeps): ManagementApi {
  return new ManagementApi(
    new ConfigChangeService({
      rootDir: deps.rootDir,
      registry: managementCommandRegistry,
      authorizeCommand: authorizeAdapterCommands('web', WEB_CHANNEL_COMMANDS),
    }),
  );
}

async function channelQuery(
  deps: UiServerDeps,
  profile: string,
): Promise<ChannelQueryInput> {
  const root = await loadRootConfig(resolveAppPaths({ rootDir: deps.rootDir }).configFile);
  const profileConfig = root?.profiles[profile];
  if (!profileConfig) throw new HttpError(404, `profile not found: ${profile}`);
  return {
    profileId: profile,
    instances: projectProfileChannelInstances({ profileId: profile, profile: profileConfig }),
    declaredPackages: profileConfig.channels?.plugins,
    runtime: { external: deps.supervisor.externalChannelsFor(profile) },
  };
}

async function resolveProfile(deps: UiServerDeps, explicit?: string): Promise<string> {
  const profile = explicit ?? (await readActiveProfileProjection(deps.rootDir));
  if (!profile) throw new HttpError(400, 'no active profile; pass profile');
  return profile;
}

export async function channelStatus(
  deps: UiServerDeps,
  profile?: string,
): Promise<ChannelStatusSnapshot> {
  return getChannelStatus(await channelQuery(deps, await resolveProfile(deps, profile)));
}

export async function channelDiagnose(
  deps: UiServerDeps,
  profile?: string,
): Promise<ChannelDiagnostic[]> {
  return diagnoseChannels(await channelQuery(deps, await resolveProfile(deps, profile)));
}

export async function channelPlan(
  deps: UiServerDeps,
  body: { profile?: string; command?: string; input?: Record<string, unknown> },
): Promise<unknown> {
  if (!body.command || !CHANNEL_COMMAND_IDS.has(body.command)) {
    throw new HttpError(400, `unsupported channel command: ${String(body.command)}`);
  }
  const { plan } = await managementApi(deps).plan({
    schema: 'aria.management.plan.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    profile: await resolveProfile(deps, body.profile),
    command: body.command,
    input: (body.input ?? {}) as ControlPlanParameters,
    actor: actor(),
  });
  return plan;
}

export async function channelPlanShow(deps: UiServerDeps, planId?: string): Promise<unknown> {
  if (!planId) throw new HttpError(400, 'planId is required');
  const { plan } = await managementApi(deps).getPlan({
    schema: 'aria.management.plan-read.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    planId,
    actor: actor(),
  });
  return plan;
}

export async function channelPlanConfirm(
  deps: UiServerDeps,
  body: { planId?: string },
): Promise<unknown> {
  if (!body.planId) throw new HttpError(400, 'planId is required');
  const { plan } = await managementApi(deps).confirm({
    schema: 'aria.management.confirm.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    planId: body.planId,
    actor: actor(),
  });
  return plan;
}

export async function channelPlanCommit(
  deps: UiServerDeps,
  body: { planId?: string },
): Promise<unknown> {
  if (!body.planId) throw new HttpError(400, 'planId is required');
  const { applyResult } = await managementApi(deps).commit({
    schema: 'aria.management.commit.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    planId: body.planId,
    actor: actor(),
  });
  return applyResult;
}
