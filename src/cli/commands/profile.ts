import { startProfileOnHost } from '../profile-online';
import { existsSync } from 'node:fs';
import { resolveAppPaths } from '../../config/app-paths';
import { paths } from '../../config/paths';
import {
  loadRootConfig,
  agentKindFromString,
  formatRootConfig,
  runtimeProfileConfig,
} from '../../config/profile-store';
import type { RootConfig } from '../../config/profile-schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { writeFileAtomic } from '../../platform/atomic-write';
import { readAndPrune } from '../../runtime/registry';
import { listAllProfiles } from '../../runtime/profile-discovery';
import { resolveProfileRuntime } from '../../runtime/profile-runtime';
import {
  authorizeAdapterCommands,
  PROFILE_ARCHIVE_COMMAND,
  PROFILE_PURGE_COMMAND,
  ProfileLifecycleService,
} from '../../application/control';
import { localCliActor } from '../control-actor';

export interface ProfileCommandOptions {
  rootDir?: string;
}

export interface ProfileCreateOptions extends ProfileCommandOptions {
  /** Defaults to start in an interactive terminal, configuration-only in scripts. */
  start?: boolean;
  agent?: string;
  workspace?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
}

export interface ProfileRemoveOptions extends ProfileCommandOptions {
  purge?: boolean;
  yes?: boolean;
  now?: () => Date;
}

export interface ProfileExportOptions extends ProfileCommandOptions {
  output?: string;
  force?: boolean;
  includeSecrets?: boolean;
  yes?: boolean;
}

export async function runProfileList(opts: ProfileCommandOptions = {}): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  let profiles;
  try {
    profiles = await listAllProfiles(rootDir);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('root config not found:')) throw err;
    console.log('暂无 profile。');
    return;
  }

  const registryFile = resolveAppPaths({ rootDir }).userRegistryFile;
  const running = readAndPrune(registryFile);
  const rows = profiles.map((profile) => {
    const holders = running
      .filter((entry) => entry.profileName === profile.name)
      .map((entry) => `pid=${entry.pid} agent=${entry.agentKind}`);
    return {
      active: profile.active ? '*' : '',
      profile: profile.name,
      agent: profile.agentKind,
      status: holders.length > 0 ? holders.join(', ') : '-',
    };
  });
  const widths = {
    active: Math.max('ACTIVE'.length, ...rows.map((row) => row.active.length)),
    profile: Math.max('PROFILE'.length, ...rows.map((row) => row.profile.length)),
    agent: Math.max('AGENT'.length, ...rows.map((row) => row.agent.length)),
  };
  console.log(formatProfileListRow({
    active: 'ACTIVE',
    profile: 'PROFILE',
    agent: 'AGENT',
    status: 'STATUS',
  }, widths));
  for (const row of rows) {
    console.log(formatProfileListRow(row, widths));
  }
}

function formatProfileListRow(
  row: { active: string; profile: string; agent: string; status: string },
  widths: { active: number; profile: number; agent: number },
): string {
  return [
    row.active.padEnd(widths.active),
    row.profile.padEnd(widths.profile),
    row.agent.padEnd(widths.agent),
    row.status,
  ].join('  ');
}

export async function runProfileCreate(
  name: string,
  opts: ProfileCreateOptions = {},
): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  const root = await loadRootConfig(configFile);
  const existing = root?.profiles[name];
  if (existing) {
    const requested = agentKindFromString(opts.agent);
    if (requested && existing.agentKind !== requested) {
      throw new Error(
        `profile ${name} already exists with agentKind ${existing.agentKind}, ` +
          `but profile create requested --agent ${requested}. ` +
          `Profile names are labels; use the existing ${existing.agentKind} profile, ` +
          `choose another name, or remove profile ${name} before creating a ${requested} profile.`,
      );
    }
    throw new Error(`profile already exists: ${name}`);
  }

  await resolveProfileRuntime({
    config: configFile,
    profile: name,
    agent: opts.agent,
    workspace: opts.workspace,
    appId: opts.appId,
    appSecret: opts.appSecret,
    tenant: opts.tenant,
    allowBootstrap: true,
  });
  console.log(`✓ profile「${name}」配置已保存。`);
  const shouldStart = opts.start ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (shouldStart) {
    try {
      await runProfileStart(name, opts);
    } catch (error) {
      throw new Error(`配置已保存，但未确认上线：${error instanceof Error ? error.message : String(error)}\n无需重新创建；重试：aria profile start ${name}`);
    }
  } else {
    console.log(`尚未启动，暂不能接收消息。上线：aria profile start ${name}`);
  }
}

export async function runProfileStart(name: string, opts: ProfileCommandOptions = {}): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile);
  if (!root?.profiles[name]) throw new Error(`profile not found: ${name}`);
  console.log(`正在通过 Supervisor 启动 profile「${name}」…`);
  await startProfileOnHost(name, rootDir);
  console.log(`✓ profile「${name}」启动成功。请发送一条私聊消息验证实际回复。`);
}

export async function runProfileUse(
  name: string,
  opts: ProfileCommandOptions = {},
): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const result = await new ProfileLifecycleService({ rootDir }).activate(
    name,
    localCliActor(rootDir),
  );
  console.log(`已切换到 profile: ${name}`);
  if (result.projection.status === 'failed') {
    console.warn('⚠ active-profile 兼容投影写入失败；config.json 已完成切换');
  }
}

export async function runProfileRemove(
  name: string,
  opts: ProfileRemoveOptions = {},
): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  if (opts.purge && !opts.yes) {
    throw new Error('profile remove --purge requires --yes');
  }
  const service = new ProfileLifecycleService({
    rootDir,
    ...(opts.now ? { now: opts.now } : {}),
    authorizeCommand: authorizeAdapterCommands(
      'local-cli',
      [opts.purge ? PROFILE_PURGE_COMMAND : PROFILE_ARCHIVE_COMMAND],
    ),
  });
  const result = opts.purge
    ? await service.purge(name, localCliActor(rootDir))
    : await service.archive(name, localCliActor(rootDir));
  if (result.mode === 'purge') {
    console.log(`已永久删除 profile: ${name}`);
    if (result.cleanup.status === 'failed') {
      console.warn(`⚠ profile 已从配置删除，但暂存目录清理失败: ${result.archivedTo ?? name}`);
    }
  } else {
    console.log(`已归档 profile: ${name}${result.archivedTo ? ` -> ${result.archivedTo}` : ''}`);
  }
  if (result.projection.status === 'failed') {
    console.warn('⚠ active-profile 兼容投影写入失败；config.json 已完成更新');
  }
}

export async function runProfileExport(
  name: string,
  opts: ProfileExportOptions = {},
): Promise<void> {
  if (opts.includeSecrets && !opts.yes) {
    throw new Error('profile export --include-secrets requires --yes');
  }
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  const root = await loadRootConfig(configFile);
  if (!root) throw new Error('config not initialized');
  const selected = root.profiles[name];
  if (!selected) throw new Error(`profile not found: ${name}`);

  const profile = cloneJson(selected);
  if (opts.includeSecrets) {
    profile.accounts.app.secret = await resolveAppSecret(
      runtimeProfileConfig(root, name),
      resolveAppPaths({ rootDir, profile: name }),
    );
  }
  const exportedBase: RootConfig = {
    schemaVersion: profile.schemaVersion,
    activeProfile: name,
    preferences: {},
    ...(opts.includeSecrets && root.secrets ? { secrets: cloneJson(root.secrets) } : {}),
    profiles: {
      [name]: profile,
    },
  };
  const exported = exportedBase;
  if (!opts.includeSecrets) {
    delete profile.secrets;
    profile.accounts.app.secret = '[REDACTED]';
  }
  const body = formatRootConfig(exported);

  if (!opts.output) {
    console.log(body.trimEnd());
    return;
  }
  if (existsSync(opts.output) && !opts.force) {
    throw new Error('output already exists; use --force');
  }
  await writeFileAtomic(opts.output, body, { mode: 0o600 });
  console.log(`已导出 profile: ${name} -> ${opts.output}`);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
