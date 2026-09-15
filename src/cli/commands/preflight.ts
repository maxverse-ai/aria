import { paths } from '../../config/paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import type { RestartBlocker, RuntimeActivitySnapshotV1 } from '../../runtime/activity';
import { RestartSafetyService } from '../../runtime/restart-safety';

export interface RestartPreflightCliOptions {
  profile?: string;
  json?: boolean;
}

export type RestartPreflightOutput =
  | {
      schemaVersion: 1;
      status: 'safe' | 'blocked';
      exitCode: 0 | 2;
      profile: string;
      snapshot: RuntimeActivitySnapshotV1;
      recommendedAction: { command: string; args: string[] } | null;
    }
  | {
      schemaVersion: 1;
      status: 'unavailable';
      exitCode: 3;
      profile: string;
      error: { code: string; message: string };
      recommendedAction: { command: string; args: string[] };
    };

export async function runRestartPreflight(opts: RestartPreflightCliOptions): Promise<0 | 2 | 3> {
  const root = await loadRootConfig(paths.configFile);
  const profile = opts.profile ?? (await readActiveProfile(paths.rootDir)) ?? root?.activeProfile;
  if (!profile) throw new Error('no active profile; pass --profile <name>');
  const safety = new RestartSafetyService({ rootDir: paths.rootDir });
  const report = await safety.assess({
    kind: 'profile-service',
    serviceId: profile,
    profiles: [profile],
  });
  const assessment = report.profiles[0];
  if (!assessment) throw new Error(`restart preflight did not assess profile: ${profile}`);

  let output: RestartPreflightOutput;
  if (assessment.status !== 'unavailable') {
    const snapshot = assessment.snapshot;
    const safe = snapshot.decision === 'safe';
    output = {
      schemaVersion: 1,
      status: safe ? 'safe' : 'blocked',
      exitCode: safe ? 0 : 2,
      profile,
      snapshot,
      recommendedAction: null,
    };
  } else {
    output = {
      schemaVersion: 1,
      status: 'unavailable',
      exitCode: 3,
      profile,
      error: assessment.error,
      recommendedAction: {
        command: 'aria',
        args: ['status', '--profile', profile],
      },
    };
  }

  console.log(opts.json ? JSON.stringify(output, null, 2) : formatRestartPreflight(output));
  return output.exitCode;
}

export function formatRestartPreflight(output: RestartPreflightOutput): string {
  if (output.status === 'unavailable') {
    return [
      `✗ 无法确认 profile「${output.profile}」是否可以安全重启。`,
      `  ${output.error.code}: ${output.error.message}`,
      '  状态未知时默认不应重启；请先确认 daemon 状态。',
    ].join('\n');
  }
  if (output.status === 'safe') {
    return [
      `✓ profile「${output.profile}」当前可以安全重启。`,
      `  instance: ${output.snapshot.instanceId}`,
      `  observed: ${output.snapshot.observedAt}`,
    ].join('\n');
  }
  return [
    `⚠ profile「${output.profile}」当前有未完成工作，不建议重启。`,
    ...output.snapshot.blockers.map(formatBlocker),
    '',
    '当前命令只执行检查，没有修改或中断运行中的工作。',
  ].join('\n');
}

function formatBlocker(blocker: RestartBlocker): string {
  const labels: Record<RestartBlocker['code'], string> = {
    ACTIVE_RUNS: 'Agent runs',
    PREPARING_RUNS: 'Preparing runs',
    PENDING_MESSAGES: 'Pending messages',
    BLOCKED_SCOPES: 'Accepted batches finishing',
    OUTBOUND_IN_FLIGHT: 'Outbound operations',
    STREAMING_REPLIES: 'Streaming replies',
    ACTIVE_MEETINGS: 'Active meetings',
  };
  return `  ${labels[blocker.code]}: ${blocker.count}`;
}
