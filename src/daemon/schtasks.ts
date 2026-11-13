import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  windowsTaskName,
  windowsLauncherCmdPath,
} from './paths';
import { paths } from '../config/paths';
import { currentRuntime, isBunRuntime, runtimeEntryPath } from '../platform/runtime';
import type { ServiceLaunchSpec } from './service-adapter';
import { bootTaskScript, logonTaskScript, readWindowsTaskStatus, runTaskPowerShell, selectAutostartMode, type AutostartMode } from './windows-autostart';

export { readWindowsTaskStatus } from './windows-autostart';

export interface LauncherInputs {
  /** Absolute path to the JS runtime executable (node.exe or bun.exe). */
  runtimePath: string;
  /** Absolute path to the bridge CLI entry. Omitted for embedded entries
   * inside a compiled runtime binary. */
  bridgeEntryPath?: string;
  /** PATH for the child process; baked into the .cmd via `set PATH=`. */
  envPath: string;
  /** Service id (profile name, or the reserved supervisor id) — drives the
   * task name and log paths. */
  profile: string;
  /** CLI args after the entry path, e.g. `['run', '--profile', 'claude']` or
   * `['run', '--web-ui']`. */
  runArgs: string[];
  /** Root directory for config/profile state. */
  channelHome: string;
  /** Packaged independent host; omitted for compiled/legacy distributions. */
  hostEntryPath?: string;
}

/**
 * Generate the .cmd wrapper script that the scheduled task actually invokes.
 *
 * schtasks `/TR` can accept a direct command, but we need stdout/stderr
 * redirection + a PATH override so child tools (lark-cli, claude) resolve
 * correctly when the daemon runs under Task Scheduler. A `.cmd` script
 * is the natural place for both.
 *
 * `@echo off` keeps the script's own commands out of the daemon log.
 * `>>` / `2>>` append (not truncate) so log history is preserved across
 * daemon restarts.
 */
export function buildLauncherCmd(inputs: LauncherInputs): string {
  // Profile names / flags are validated safe tokens (no spaces).
  const runArgs = inputs.runArgs.join(' ');
  return [
    '@echo off',
    `set "LARK_CHANNEL_HOME=${inputs.channelHome}"`,
    `set "PATH=${inputs.envPath}"`,
    inputs.hostEntryPath
      ? `"${inputs.runtimePath}" "${inputs.hostEntryPath}" "${inputs.profile}" "${daemonLogDir(inputs.profile)}" "${inputs.runtimePath}" "${inputs.bridgeEntryPath ?? '-'}" ${runArgs} >> "${daemonLogDir(inputs.profile)}\\host-stdout.log" 2>> "${daemonLogDir(inputs.profile)}\\host-stderr.log"`
      : `"${inputs.runtimePath}"${inputs.bridgeEntryPath ? ` "${inputs.bridgeEntryPath}"` : ''} ${runArgs} >> "${daemonStdoutPath(inputs.profile)}" 2>> "${daemonStderrPath(inputs.profile)}"`,
    '',
  ].join('\r\n');
}

async function writeLauncherCmd(
  profile: string,
  runArgs: string[] = ['run'],
  launchSpec?: ServiceLaunchSpec,
): Promise<void> {
  const bridgeEntryPath = launchSpec?.bridgeEntryPath ?? runtimeEntryPath();
  if (!bridgeEntryPath && !isBunRuntime()) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildLauncherCmd({
    runtimePath: launchSpec?.runtimePath ?? currentRuntime.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? '',
    profile,
    runArgs,
    channelHome: paths.rootDir,
    ...(bridgeEntryPath && existsSync(join(dirname(bridgeEntryPath), '..', 'dist', 'daemon.js'))
      ? {hostEntryPath: join(dirname(bridgeEntryPath), '..', 'dist', 'daemon.js')}
      : bridgeEntryPath && existsSync(join(dirname(bridgeEntryPath), 'daemon.js'))
        ? {hostEntryPath: join(dirname(bridgeEntryPath), 'daemon.js')}
        : {}),
  });
  const cmdPath = windowsLauncherCmdPath(profile);
  await mkdir(dirname(cmdPath), { recursive: true });
  await mkdir(daemonLogDir(profile), { recursive: true });
  await writeFile(cmdPath, content, 'utf8');
}

interface SchtasksResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

function runSchtasks(args: string[]): SchtasksResult {
  const r = spawnSync('schtasks', args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? '',
    stdout: r.stdout ?? '',
  };
}

/**
 * Register autostart adaptively; preserve existing registrations by default so
 * a saved boot principal/password is never replaced by an ONLOGON task.
 * New tasks run as the current user with limited privileges. Logon mode uses
 * an account-specific trigger and interactive token, without storing a password.
 */
export async function installTask(
  profile: string,
  runArgs: string[] = ['run'],
  launchSpec?: ServiceLaunchSpec,
  autostart: AutostartMode = 'auto',
): Promise<SchtasksResult> {
  const taskName = windowsTaskName(profile);
  const before = readWindowsTaskStatus(taskName);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const selected = selectAutostartMode(autostart, before, interactive);
  await writeLauncherCmd(profile, runArgs, launchSpec);
  if (selected === 'preserve') return { ok: true, stderr: '', stdout: '' };
  if (selected === 'boot') {
    const result = runTaskPowerShell(bootTaskScript(taskName, windowsLauncherCmdPath(profile), paths.rootDir, before.currentUser), true);
    if (result.status === 0) {
      const after = readWindowsTaskStatus(taskName);
      if (!after.installed || after.mode !== 'boot' || after.logonType !== 'Password' || !after.enabled) {
        throw new Error('Boot task registration could not be verified. Inspect aria status before retrying.');
      }
      return { ok: true, stderr: '', stdout: '' };
    }
    if (result.status !== 2 || autostart !== 'auto') {
      throw new Error('Boot autostart was cancelled or failed. No logon fallback was applied. Check the Windows error above; use an Administrator terminal and the Windows account password.');
    }
    console.warn('Aria: boot setup skipped; configuring logon autostart.');
  }
  const registered = runTaskPowerShell(logonTaskScript(taskName, windowsLauncherCmdPath(profile), paths.rootDir, before.currentUser));
  const result = { ok: registered.status === 0, stdout: registered.stdout ?? '', stderr: registered.stderr || registered.error?.message || '' };
  if (result.ok) {
    const after = readWindowsTaskStatus(taskName);
    if (!after.installed || after.mode !== 'logon' || !after.enabled) {
      throw new Error('Logon autostart registration could not be verified. Inspect aria status.');
    }
  }
  return result;
}

/** Start the task now (regardless of trigger). */
export function runTask(profile: string): SchtasksResult {
  return runSchtasks(['/Run', '/TN', windowsTaskName(profile)]);
}

/** End the running instance. Task stays registered for next logon. */
export function endTask(profile: string): SchtasksResult {
  return runSchtasks(['/End', '/TN', windowsTaskName(profile)]);
}

/** Disable autostart (task stays registered but ONLOGON trigger won't fire). */
export function disableTask(profile: string): SchtasksResult {
  return runSchtasks(['/Change', '/TN', windowsTaskName(profile), '/Disable']);
}

/** Re-enable autostart. Called from installTask is unnecessary — /Create /F
 * resets the enabled flag. Only needed if you Disabled and want it back. */
export function enableTask(profile: string): SchtasksResult {
  return runSchtasks(['/Change', '/TN', windowsTaskName(profile), '/Enable']);
}

/** End + disable. The cross-platform "stop = stay stopped" semantic. */
export function endAndDisable(profile: string): SchtasksResult {
  const ended = endTask(profile);
  // If the task wasn't running, /End fails; we still want to disable.
  const disabled = disableTask(profile);
  // Surface whichever signal is more informative — disable result wins
  // because the autostart prevention is the user-visible effect.
  return disabled.ok ? disabled : ended.ok ? disabled : ended;
}

/** Schtasks has no native restart — end, wait, run. */
export async function restartTask(profile: string): Promise<SchtasksResult> {
  endTask(profile); // best-effort; ignore if not running
  await waitUntilStopped(profile);
  return runTask(profile);
}

/**
 * `schtasks /Query` returns 0 iff the task is registered. We toss the
 * output (it's verbose); use describeTask for full state.
 */
export function isTaskRegistered(profile: string): boolean {
  const r = spawnSync('schtasks', ['/Query', '/TN', windowsTaskName(profile)], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

/**
 * Query the numeric scheduler state, independent of Windows display language.
 */
export function isTaskRunning(profile: string): boolean {
  return readWindowsTaskStatus(windowsTaskName(profile)).running;
}

export function describeTask(profile: string): string {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', windowsTaskName(profile)]);
  return r.stdout || r.stderr || '';
}

export async function waitUntilStopped(profile: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTaskRunning(profile)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteTask(profile: string): Promise<SchtasksResult> {
  const r = runSchtasks(['/Delete', '/F', '/TN', windowsTaskName(profile)]);
  // Remove the launcher script too; best-effort.
  if (existsSync(windowsLauncherCmdPath(profile))) {
    await rm(windowsLauncherCmdPath(profile), { force: true });
  }
  return r;
}
