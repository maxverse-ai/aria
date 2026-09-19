import {
  triggerCapabilities,
  triggerContractSchema,
  type TriggerCapabilitySnapshot,
  type TriggerContractSchemaSnapshot,
} from '../../application/execution-intent';
import { randomUUID } from 'node:crypto';
import { resolveAppPaths } from '../../config/app-paths';
import {
  AgentTriggerGovernanceApi,
  type AgentTriggerCommand,
  type AgentTriggerGrantIssueInput,
  type AgentTriggerGrantView,
} from '../../trigger/agent';
import {
  TriggerManagementApi,
  type TriggerManagementCommand,
  type TriggerPlanSnapshot,
  type TriggerReadSnapshot,
} from '../../trigger/operations';
import { positiveIntOption } from '../parse';

export interface TriggerContractCliOptions {
  json?: boolean;
  rootDir?: string;
}

const cliActor = { source: 'local-cli' as const, principal: 'aria-trigger-cli' };
export const AGENT_TRIGGER_TOKEN_ENV = 'ARIA_TRIGGER_GRANT_TOKEN';

export async function runTriggerCapabilities(
  opts: TriggerContractCliOptions = {},
): Promise<void> {
  const snapshot = triggerCapabilities();
  printSnapshot(snapshot, opts.json, formatTriggerCapabilities);
}

export async function runTriggerSchema(
  name: string,
  opts: TriggerContractCliOptions = {},
): Promise<void> {
  const snapshot = triggerContractSchema(name);
  printSnapshot(snapshot, opts.json, formatTriggerSchema);
}

export async function runTriggerList(opts: TriggerContractCliOptions & { profile?: string } = {}): Promise<void> {
  const snapshot = await api(opts).read(opts.profile ? { profileId: opts.profile } : {});
  printSnapshot(snapshot, opts.json, formatTriggerRead);
}

export async function runTriggerGet(id: string, opts: TriggerContractCliOptions = {}): Promise<void> {
  const snapshot = await api(opts).read({ definitionId: id });
  printSnapshot(snapshot, opts.json, formatTriggerRead);
}

export async function runTriggerPreview(id: string, opts: TriggerContractCliOptions & { count?: string } = {}): Promise<void> {
  const count = positiveIntOption(opts.count, '--count', 5);
  const snapshot = await api(opts).preview(id, count);
  console.log(opts.json ? JSON.stringify(snapshot, null, 2) : snapshot.fireTimes.map((at) => new Date(at).toISOString()).join('\n'));
}

export async function runTriggerPlan(
  command: string,
  opts: TriggerContractCliOptions & { input?: string } = {},
): Promise<void> {
  const result = await api(opts).plan({
    schema: 'aria.trigger-management.plan.request.v1', apiVersion: 1, requestId: randomUUID(),
    actor: cliActor, command: parseCommand(command), input: parseInput(opts.input),
  });
  printSnapshot(result.plan, opts.json, formatTriggerPlan);
}

export async function runTriggerPlanShow(planId: string, opts: TriggerContractCliOptions = {}): Promise<void> {
  const result = await api(opts).getPlan(actionRequest(planId));
  printSnapshot(result.plan, opts.json, formatTriggerPlan);
}

export async function runTriggerConfirm(planId: string, opts: TriggerContractCliOptions = {}): Promise<void> {
  const result = await api(opts).confirm(actionRequest(planId));
  printSnapshot(result.plan, opts.json, formatTriggerPlan);
}

export async function runTriggerApply(planId: string, opts: TriggerContractCliOptions = {}): Promise<void> {
  const result = await api(opts).apply(actionRequest(planId));
  console.log(opts.json ? JSON.stringify(result, null, 2) : `${result.command} applied · ${result.definition?.id ?? result.occurrence?.id ?? result.planId}`);
}

export async function runTriggerExecute(
  command: string,
  opts: TriggerContractCliOptions & { input?: string; yes?: boolean } = {},
): Promise<void> {
  if (!opts.yes) throw new Error('mutation requires --yes; use `aria trigger plan` to review it first');
  const result = await api(opts).execute({
    schema: 'aria.trigger-management.execute.request.v1', apiVersion: 1, requestId: randomUUID(),
    actor: cliActor, command: parseCommand(command), input: parseInput(opts.input),
  });
  console.log(opts.json ? JSON.stringify(result, null, 2) : `${result.command} applied · ${result.definition?.id ?? result.occurrence?.id ?? result.planId}`);
}

export async function runTriggerGrantIssue(
  opts: TriggerContractCliOptions & { input?: string; yes?: boolean } = {},
): Promise<void> {
  if (!opts.yes) throw new Error('grant issuance requires --yes');
  const created = await governance(opts).issue(parseInput(opts.input) as unknown as AgentTriggerGrantIssueInput, cliActor);
  console.log(opts.json
    ? JSON.stringify(created, null, 2)
    : [`Agent trigger grant ${created.grant.id} issued.`, 'Token (shown once):', created.token].join('\n'));
}

export async function runTriggerGrantRevoke(
  id: string,
  opts: TriggerContractCliOptions & { yes?: boolean } = {},
): Promise<void> {
  if (!opts.yes) throw new Error('grant revocation requires --yes');
  const revoked = await governance(opts).revoke(id, cliActor);
  console.log(opts.json ? JSON.stringify(revoked, null, 2) : `Agent trigger grant ${revoked.id} revoked.`);
}

export interface AgentTriggerGrantListSnapshot {
  schema: 'aria.agent-trigger-grant.list.v1';
  apiVersion: 1;
  grants: AgentTriggerGrantView[];
}

export async function runTriggerGrantList(
  opts: TriggerContractCliOptions = {},
): Promise<void> {
  const snapshot: AgentTriggerGrantListSnapshot = {
    schema: 'aria.agent-trigger-grant.list.v1',
    apiVersion: 1,
    grants: await governance(opts).list(cliActor),
  };
  printSnapshot(snapshot, opts.json, formatGrantList);
}

export async function runTriggerGrantGet(
  id: string,
  opts: TriggerContractCliOptions = {},
): Promise<void> {
  const grant = await governance(opts).get(id, cliActor);
  if (!grant) throw new Error(`agent trigger grant not found: ${id}`);
  printSnapshot(grant, opts.json, formatGrant);
}

export function formatGrantList(snapshot: AgentTriggerGrantListSnapshot): string {
  if (snapshot.grants.length === 0) return 'No agent trigger grants.';
  return snapshot.grants.map(formatGrant).join('\n');
}

function formatGrant(grant: AgentTriggerGrantView): string {
  const status = grantStatus(grant);
  return [
    `${grant.id}\t${status}\tprincipal=${grant.principalFingerprint.slice(0, 19)}…`,
    `  profile=${grant.profileId} engine=${grant.engineId}`,
    `  expires=${new Date(grant.expiresAt).toISOString()} created=${new Date(grant.createdAt).toISOString()}`,
    `  limits: definitions<=${grant.limits.maxActiveDefinitions} runs/day<=${grant.limits.maxRunsPerDay} runtime<=${grant.limits.maxRuntimeMs}ms prompt<=${grant.limits.maxPromptBytes}B schedules=${grant.limits.allowedScheduleKinds.join('|')}`,
  ].join('\n');
}

function grantStatus(grant: AgentTriggerGrantView): 'active' | 'revoked' | 'expired' {
  if (grant.state === 'revoked') return 'revoked';
  return grant.expiresAt <= Date.now() ? 'expired' : 'active';
}

export async function runAgentTrigger(
  command: string,
  opts: TriggerContractCliOptions & { engine?: string; input?: string; yes?: boolean } = {},
): Promise<void> {
  const parsed = parseAgentCommand(command);
  if (!['list', 'history'].includes(parsed) && !opts.yes) {
    throw new Error('agent trigger mutation requires --yes');
  }
  const grantToken = process.env[AGENT_TRIGGER_TOKEN_ENV];
  if (!grantToken) throw new Error(`${AGENT_TRIGGER_TOKEN_ENV} is required`);
  const result = await governance(opts).execute({
    schema: 'aria.agent-trigger.execute.request.v1',
    apiVersion: 1,
    requestId: randomUUID(),
    grantToken,
    engineId: opts.engine ?? '',
    command: parsed,
    input: parseInput(opts.input),
  });
  console.log(opts.json
    ? JSON.stringify(result, null, 2)
    : result.definition
      ? `${result.command} applied · ${result.definition.id}`
      : formatTriggerRead(result.snapshot!));
}

function printSnapshot<T>(snapshot: T, json: boolean | undefined, format: (value: T) => string): void {
  console.log(json ? JSON.stringify(snapshot, null, 2) : format(snapshot));
}

export function formatTriggerCapabilities(snapshot: TriggerCapabilitySnapshot): string {
  return [
    `Aria trigger API v${snapshot.apiVersion}`,
    `implementation: ${snapshot.implementationStage}`,
    'runtime: disabled by default (enable with ARIA_TRIGGER_RUNTIME=enabled)',
    ...snapshot.capabilities.map((item) => `- ${item.id}: ${item.cli} [${item.access}]`),
  ].join('\n');
}

export function formatTriggerSchema(snapshot: TriggerContractSchemaSnapshot): string {
  return [
    `Aria trigger contract · ${snapshot.name} v${snapshot.contractVersion}`,
    JSON.stringify(snapshot.jsonSchema, null, 2),
  ].join('\n');
}

export function formatTriggerRead(snapshot: TriggerReadSnapshot): string {
  if (snapshot.definitions.length === 0) return 'No trigger definitions.';
  return snapshot.definitions.map((definition) => {
    const runs = snapshot.occurrences.filter((item) => item.definitionId === definition.id);
    return `${definition.id}\t${definition.profileId}\t${definition.state}\t${definition.metadata.label ?? ''}\truns=${runs.length}\tnext=${definition.nextFireAt ? new Date(definition.nextFireAt).toISOString() : '-'}`;
  }).join('\n');
}

export function formatTriggerPlan(plan: TriggerPlanSnapshot): string {
  return [
    `Trigger plan ${plan.id} · ${plan.command} · ${plan.status}`,
    ...plan.summary.map((item) => `- ${item.field}: ${String(item.before)} -> ${String(item.after)}`),
    `expires: ${plan.expiresAt}`,
  ].join('\n');
}

function api(opts: Pick<TriggerContractCliOptions, 'rootDir'>): TriggerManagementApi {
  return new TriggerManagementApi({
    rootDir: opts.rootDir ?? process.env.LARK_CHANNEL_HOME ?? resolveAppPaths().rootDir,
  });
}

function governance(opts: Pick<TriggerContractCliOptions, 'rootDir'>): AgentTriggerGovernanceApi {
  return new AgentTriggerGovernanceApi({ rootDir: rootDir(opts) });
}

function rootDir(opts: Pick<TriggerContractCliOptions, 'rootDir'>): string {
  return opts.rootDir ?? process.env.LARK_CHANNEL_HOME ?? resolveAppPaths().rootDir;
}

function actionRequest(planId: string) {
  return {
    schema: 'aria.trigger-management.plan-action.request.v1' as const,
    apiVersion: 1 as const, requestId: randomUUID(), actor: cliActor, planId,
  };
}

function parseInput(source: string | undefined): Record<string, unknown> {
  if (!source) return {};
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('--input must be a JSON object');
  return value as Record<string, unknown>;
}

function parseCommand(value: string): TriggerManagementCommand {
  if (['create', 'update', 'pause', 'resume', 'cancel', 'run-now', 'retry', 'ack'].includes(value)) {
    return value as TriggerManagementCommand;
  }
  throw new Error(`unknown trigger command: ${value}`);
}

function parseAgentCommand(value: string): AgentTriggerCommand {
  if (['create', 'list', 'history', 'snooze', 'update', 'cancel'].includes(value)) {
    return value as AgentTriggerCommand;
  }
  throw new Error(`unknown agent trigger command: ${value}`);
}
