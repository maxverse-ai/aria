import { applyExecutionSpawn, type ExecutionEnvironment, type ExecutionProcessHooks } from '../execution/types';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, delimiter, dirname } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import type { SpawnOptions, SpawnSyncOptions } from 'node:child_process';
import type { SpacePaths } from './paths';
import { within } from './paths';

/** Trusted deployment input. No engine/profile/worker JSON may supply this directly. */
export interface ConfinedLaunch {
  readonly binary: string;
  /** Acquired by the profile owner; never deserialized from deployment JSON. */
  readonly executionEnvironment?: ExecutionEnvironment;
  /** Absent means bubblewrap for compatibility. Missing drivers never fall back. */
  readonly driver?: 'bubblewrap' | 'trusted-process' | 'execution';
  readonly bubblewrap?: string;
  readonly paths: SpacePaths;
  readonly workspaceAccess: 'read-only' | 'workspace' | 'full';
  readonly executableRoots: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  /** Optional proxy child entry, exposing only a space-specific broker socket. */
  readonly proxy?: { node: string; entry: string; socket: string };
}
const launches = new AsyncLocalStorage<ConfinedLaunch>();
export function withConfinedLaunch<T>(launch: ConfinedLaunch, operation: () => T): T {
  return launches.run(launch, operation);
}

/** All native subprocess creation goes through this boundary, including native queries. */
export function confineSpawn<T extends SpawnOptions | SpawnSyncOptions>(command: string, args: readonly string[], options: T): {
  command: string; args: readonly string[]; options: T;
} & ExecutionProcessHooks {
  const launch = launches.getStore();
  if (!launch) return { command, args, options };
  const driver = launch.driver ?? 'bubblewrap';
  if (driver !== 'bubblewrap' && driver !== 'trusted-process' && driver !== 'execution') throw new Error('unsupported space execution driver');
  if (driver === 'execution' && !launch.executionEnvironment) throw new Error('execution environment has not been acquired');
  if (!launch.executionEnvironment && driver === 'bubblewrap' && (process.platform !== 'linux' || !launch.bubblewrap || !isAbsolute(launch.bubblewrap))) {
    throw new Error('space execution requires an explicit supported isolation driver');
  }
  if (!isAbsolute(command) || command !== launch.binary) throw new Error('space subprocess is not the admitted engine binary');
  if (options.shell) throw new Error('space launch cannot use a host shell');
  const cwd = typeof options.cwd === 'string' ? options.cwd : launch.paths.workspace;
  if (!within(launch.paths.engine, cwd)) throw new Error('space cwd escapes execution root');
  const env: Record<string, string> = {
    PATH: [dirname(launch.binary), ...launch.executableRoots.flatMap((root) => [root, root + '/bin']), '/usr/bin', '/bin'].join(delimiter),
    HOME: launch.paths.home, XDG_CONFIG_HOME: launch.paths.config, XDG_DATA_HOME: launch.paths.data,
    XDG_CACHE_HOME: launch.paths.cache, XDG_STATE_HOME: launch.paths.state,
    LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1', ...launch.environment,
  };
  // Native adapters can narrow/select paths inside the already confined root,
  // but cannot reintroduce host credentials or startup hooks through ambient env.
  const pathKeys = new Set(['CODEX_HOME', 'GROK_HOME', 'DSH_HOME', 'PI_CODING_AGENT_DIR', 'CLAUDE_CONFIG_DIR', 'OPENCODE_CONFIG_DIR',
    'LARK_CHANNEL_HOME', 'LARK_CHANNEL_CONFIG', 'LARKSUITE_CLI_CONFIG_DIR']);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) continue;
    if (pathKeys.has(key) && within(launch.paths.engine, value)) env[key] = value;
  }
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    if (!within(launch.paths.engine, env[key]!)) throw new Error('space environment path escapes execution root');
  }
  for (const key of Object.keys(env)) {
    if (/^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$)/.test(key)) throw new Error('unsafe space launch environment');
  }
  if (launch.executionEnvironment) {
    const request = launch.proxy
      ? { command: launch.proxy.node, args: [launch.proxy.entry, launch.proxy.socket, command, ...args], cwd, env }
      : { command, args, cwd, env };
    return applyExecutionSpawn(launch.executionEnvironment, request, options);
  }
  // This explicitly admitted deployment protects application ownership and
  // environment selection, not OS resources. Its children retain host access.
  // Both execution and native queries still use the same space-owned runtime.
  if (driver === 'trusted-process') {
    if (launch.proxy) throw new Error('confined model proxy requires the bubblewrap driver');
    return { command, args, options: { ...options, cwd, env, shell: false } };
  }
  const sandboxArgs = [
    '--die-with-parent', '--new-session', '--unshare-all', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/etc',
    '--ro-bind-try', '/etc/ssl', '/etc/ssl', '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf',
  ];
  for (const root of launch.executableRoots) {
    if (!isAbsolute(root) || realpathSync(root) !== root || within(root, homedir())
      || ['/root', '/etc', '/run', '/proc', '/sys', '/dev', '/tmp', '/var'].includes(root)
      || within(root, launch.paths.root) || (within(launch.paths.root, root) && !within(launch.paths.tools, root))) throw new Error('unsafe space executable mount');
    sandboxArgs.push('--ro-bind', root, root);
  }
  // Immutable mount points prevent an engine from swapping a host-written
  // attachment root or native prompt directory for an escaping symlink.
  sandboxArgs.push('--ro-bind', launch.paths.engine, launch.paths.engine, '--chdir', cwd);
  for (const directory of [launch.paths.workspace, launch.paths.home, launch.paths.config, launch.paths.data, launch.paths.cache, launch.paths.state]) {
    sandboxArgs.push('--bind', directory, directory);
  }
  sandboxArgs.push('--ro-bind', launch.paths.attachments, launch.paths.attachments);
  if (launch.workspaceAccess === 'read-only') sandboxArgs.push('--ro-bind', launch.paths.workspace, launch.paths.workspace);
  const promptIndex = args.indexOf('--append-system-prompt-file');
  if (promptIndex >= 0) {
    const prompt = args[promptIndex + 1];
    if (!prompt || !within(launch.paths.control, prompt)) throw new Error('native prompt has no host-owned space path');
    sandboxArgs.push('--ro-bind', prompt, prompt);
  }
  if (launch.proxy) {
    const { node, entry, socket } = launch.proxy;
    sandboxArgs.push('--ro-bind', entry, entry, '--ro-bind', socket, '/tmp/aria-egress.sock');
    sandboxArgs.push('--', node, entry, '/tmp/aria-egress.sock', command, ...args);
  } else sandboxArgs.push('--', command, ...args);
  return { command: launch.bubblewrap!, args: sandboxArgs, options: { ...options, cwd: launch.paths.workspace, env, shell: false } };
}
