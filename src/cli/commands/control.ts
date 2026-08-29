import {
  ReadOnlyControlPlane,
  type ConfigSnapshot,
  type ControlCapabilitiesSnapshot,
  type ProfileSummarySnapshot,
  type RuntimeStatusSnapshot,
} from '../../application/control';
import { paths } from '../../config/paths';

export interface ReadOnlyControlCliOptions {
  profile?: string;
  json?: boolean;
  rootDir?: string;
}

export async function runControlCapabilities(
  opts: Pick<ReadOnlyControlCliOptions, 'json' | 'rootDir'> = {},
): Promise<void> {
  const snapshot = plane(opts).capabilities();
  printSnapshot(snapshot, opts.json, formatCapabilities);
}

export async function runProfileShow(
  profile: string | undefined,
  opts: Pick<ReadOnlyControlCliOptions, 'json' | 'rootDir'> = {},
): Promise<void> {
  const snapshot = await plane(opts).profileSummary(profile);
  printSnapshot(snapshot, opts.json, formatProfileSummary);
}

export async function runConfigShow(opts: ReadOnlyControlCliOptions = {}): Promise<void> {
  const snapshot = await plane(opts).configSnapshot(opts.profile);
  printSnapshot(snapshot, opts.json, formatConfigSnapshot);
}

export async function runRuntimeStatus(opts: ReadOnlyControlCliOptions = {}): Promise<void> {
  const snapshot = await plane(opts).runtimeStatus(opts.profile);
  printSnapshot(snapshot, opts.json, formatRuntimeStatus);
}

function plane(opts: Pick<ReadOnlyControlCliOptions, 'rootDir'>): ReadOnlyControlPlane {
  return new ReadOnlyControlPlane({ rootDir: opts.rootDir ?? paths.rootDir });
}

function printSnapshot<T>(snapshot: T, json: boolean | undefined, format: (value: T) => string): void {
  console.log(json ? JSON.stringify(snapshot, null, 2) : format(snapshot));
}

export function formatCapabilities(snapshot: ControlCapabilitiesSnapshot): string {
  return [
    `Aria control API v${snapshot.apiVersion}`,
    ...snapshot.capabilities.map((item) => `- ${item.id}: ${item.cli} [${item.access}]`),
  ].join('\n');
}

export function formatProfileSummary(snapshot: ProfileSummarySnapshot): string {
  return [
    `Aria profile · ${snapshot.profile.name}${snapshot.profile.active ? ' (active)' : ''}`,
    `agent: ${snapshot.agent.kind}`,
    `deployment: ${snapshot.deployment.mode}`,
    `tenant: ${snapshot.application.tenant}`,
    `runtime: ${snapshot.runtime.locked ? 'locked/running' : 'stopped'} · ${snapshot.runtime.registeredProcesses} registered process(es)`,
  ].join('\n');
}

export function formatConfigSnapshot(snapshot: ConfigSnapshot): string {
  return [
    `Aria config · ${snapshot.profile.name}${snapshot.profile.active ? ' (active)' : ''}`,
    `revision: ${snapshot.revision}`,
    `agent: ${snapshot.agent.kind} · model ${snapshot.agent.model} · reasoning ${snapshot.agent.reasoningEffort ?? 'default'} · tier ${snapshot.agent.serviceTier}`,
    `deployment: ${snapshot.deployment.mode}`,
    `access: ${snapshot.access.allowedUsers} users · ${snapshot.access.allowedChats} chats · ${snapshot.access.admins} admins`,
    `group mention: ${snapshot.access.requireMentionInGroup ? 'required' : 'not required'} · ${snapshot.access.chatMentionOverrides} override(s)`,
    `lark-cli: stored ${snapshot.identity.storedLarkCliPreset} · effective ${snapshot.identity.effectiveLarkCliPreset}`,
    `workspace: ${snapshot.workspace.defaultConfigured ? 'configured' : 'not configured'}`,
    `presentation: ${snapshot.presentation.messageReply} · tools ${snapshot.presentation.showToolCalls ? 'shown' : 'hidden'} · cot ${snapshot.presentation.cotMessages}`,
    `execution: max ${snapshot.execution.maxConcurrentRuns} · idle timeout ${formatDuration(snapshot.execution.runIdleTimeoutMs)} · stop grace ${formatDuration(snapshot.execution.agentStopGraceMs)}`,
    `meeting: ${snapshot.meeting.enabled ? 'enabled' : 'disabled'}`,
  ].join('\n');
}

export function formatRuntimeStatus(snapshot: RuntimeStatusSnapshot): string {
  const lines = [
    `Aria runtime · ${snapshot.profile}`,
    `lock: ${snapshot.lock.locked ? snapshot.lock.uncertain ? 'locked (uncertain)' : 'locked' : 'unlocked'}`,
  ];
  if (snapshot.lock.holder) {
    lines.push(
      `holder: pid ${snapshot.lock.holder.pid} · ${snapshot.lock.holder.agentKind} · since ${snapshot.lock.holder.startedAt}`,
    );
  }
  if (snapshot.processes.length === 0) {
    lines.push('processes: none');
  } else {
    lines.push('processes:');
    for (const process of snapshot.processes) {
      lines.push(
        `- ${process.id} · pid ${process.pid} · ${process.agentKind} · ${process.alive ? 'alive' : 'stale'} · ${process.startedAt}`,
      );
    }
  }
  return lines.join('\n');
}

function formatDuration(ms: number | null): string {
  if (ms === null) return 'disabled';
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
