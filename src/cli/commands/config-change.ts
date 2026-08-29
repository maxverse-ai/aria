import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import {
  ConfigChangeService,
  MANAGEMENT_API_VERSION,
  ManagementApi,
  configSettingsSnapshot,
  lowRiskConfigCommandRegistry,
  operationIdForSetting,
  parseSettingValue,
  type ControlActorContext,
  type ControlChangeApplyResult,
  type ControlChangePlanSnapshot,
} from '../../application/control';
import { paths } from '../../config/paths';

export interface ConfigChangeCliOptions {
  profile?: string;
  json?: boolean;
  rootDir?: string;
  actor?: ControlActorContext;
}

export async function runConfigSettings(
  opts: Pick<ConfigChangeCliOptions, 'json'> = {},
): Promise<void> {
  const snapshot = configSettingsSnapshot();
  console.log(
    opts.json
      ? JSON.stringify(snapshot, null, 2)
      : ['Supported low-risk settings:', ...snapshot.settings.map((item) =>
          `- ${item.setting}: ${item.acceptedValues} · restart required`,
        )].join('\n'),
  );
}

export async function runConfigPlan(
  setting: string,
  rawValue: string,
  opts: ConfigChangeCliOptions = {},
): Promise<void> {
  const currentActor = actor(opts);
  const { plan } = await managementApi(opts).plan({
    schema: 'aria.management.plan.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    profile: opts.profile,
    command: operationIdForSetting(setting),
    input: { value: parseSettingValue(setting, rawValue) },
    actor: currentActor,
  });
  print(plan, opts.json, formatPlan);
}

export async function runConfigPlanShow(
  planId: string,
  opts: ConfigChangeCliOptions = {},
): Promise<void> {
  const { plan } = await managementApi(opts).getPlan({
    schema: 'aria.management.plan-read.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    planId,
    actor: actor(opts),
  });
  print(plan, opts.json, formatPlan);
}

export async function runConfigConfirm(
  planId: string,
  opts: ConfigChangeCliOptions = {},
): Promise<void> {
  const { plan } = await managementApi(opts).confirm({
    schema: 'aria.management.confirm.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    planId,
    actor: actor(opts),
  });
  print(plan, opts.json, formatPlan);
}

export async function runConfigApply(
  planId: string,
  opts: ConfigChangeCliOptions = {},
): Promise<void> {
  const { applyResult } = await managementApi(opts).commit({
    schema: 'aria.management.commit.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    planId,
    actor: actor(opts),
  });
  print(applyResult, opts.json, formatApplyResult);
}

export function formatPlan(plan: ControlChangePlanSnapshot): string {
  return [
    `Aria config plan · ${plan.id}`,
    `status: ${plan.status} · profile ${plan.profile}`,
    `operation: ${plan.operation.id} · risk ${plan.operation.risk}`,
    `revision: ${plan.baseRevision} -> ${plan.targetRevision}`,
    'changes:',
    ...plan.changes.map((change) => `- ${change.field}: ${display(change.before)} -> ${display(change.after)}`),
    `expires: ${plan.expiresAt}`,
    `restart: ${plan.operation.restartRequired ? 'required' : 'not required'}`,
  ].join('\n');
}

export function formatApplyResult(result: ControlChangeApplyResult): string {
  return [
    `Applied config plan · ${result.planId}`,
    `profile: ${result.profile}`,
    `revision: ${result.baseRevision} -> ${result.resultRevision}`,
    `recovered: ${result.recovered ? 'yes' : 'no'}`,
    `restart: ${result.restartRequired ? 'required before changes take effect' : 'not required'}`,
  ].join('\n');
}

function managementApi(opts: Pick<ConfigChangeCliOptions, 'rootDir'>): ManagementApi {
  return new ManagementApi(
    new ConfigChangeService({
      rootDir: opts.rootDir ?? paths.rootDir,
      registry: lowRiskConfigCommandRegistry,
    }),
  );
}

function actor(opts: Pick<ConfigChangeCliOptions, 'actor' | 'rootDir'>): ControlActorContext {
  if (opts.actor) return opts.actor;
  const currentUser = userInfo();
  return {
    source: 'local-cli',
    principal: `${process.platform}:${currentUser.uid}:${currentUser.username}:${opts.rootDir ?? paths.rootDir}`,
  };
}

function print<T>(value: T, json: boolean | undefined, format: (value: T) => string): void {
  console.log(json ? JSON.stringify(value, null, 2) : format(value));
}

function display(value: string | number | boolean | null): string {
  return value === null ? 'null' : String(value);
}
