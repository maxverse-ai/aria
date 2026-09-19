import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';
import { paths } from '../../config/paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { daemonStderrPath, daemonStdoutPath, SUPERVISOR_SERVICE_ID } from '../../daemon/paths';
import { getServiceAdapter } from '../../daemon/service-adapter';

export interface LogsCliOptions {
  profile?: string;
  webUi?: boolean;
  follow?: boolean;
  lines?: string;
  /** Tail the daemon stdout log instead of stderr. */
  stdout?: boolean;
  rootDir?: string;
}

const DEFAULT_LINES = 100;
const FOLLOW_POLL_MS = 500;

/**
 * `aria logs` — tail the daemon log `status` already resolves. Defaults to
 * the stderr log (the daemon's diagnostic stream); `--stdout` selects the
 * stdout capture instead.
 */
export async function runLogs(opts: LogsCliOptions = {}): Promise<void> {
  const lines = parseLines(opts.lines);
  const serviceId = await resolveLogsServiceId(opts);
  const file = daemonLogPath(serviceId, opts.stdout === true, opts.rootDir);
  if (!existsSync(file)) {
    throw new Error(`no daemon log at ${file} (is the service installed and has it run once?)`);
  }
  process.stdout.write(await tailLines(file, lines));
  if (opts.follow) {
    await follow(file);
  }
}

async function resolveLogsServiceId(opts: LogsCliOptions): Promise<string> {
  if (opts.webUi) return SUPERVISOR_SERVICE_ID;
  const rootDir = opts.rootDir ?? paths.rootDir;
  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile);
  const profile = opts.profile ?? (await readActiveProfile(rootDir)) ?? root?.activeProfile;
  if (!profile) {
    throw new Error('active profile is required for logs; pass --profile <name>');
  }
  // Same fallback `stop`/`status` apply: without an explicit --profile, a
  // missing per-profile service file means the supervisor owns the daemon.
  if (
    !opts.profile &&
    !serviceFileExists(profile) &&
    serviceFileExists(SUPERVISOR_SERVICE_ID)
  ) {
    return SUPERVISOR_SERVICE_ID;
  }
  return profile;
}

function serviceFileExists(serviceId: string): boolean {
  return getServiceAdapter(serviceId)?.fileExists() ?? false;
}

function daemonLogPath(serviceId: string, stdout: boolean, rootDir?: string): string {
  if (!rootDir) return stdout ? daemonStdoutPath(serviceId) : daemonStderrPath(serviceId);
  const name = stdout ? 'daemon-stdout.log' : 'daemon-stderr.log';
  return join(resolveAppPaths({ rootDir, profile: serviceId }).logsDir, 'daemon', name);
}

function parseLines(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LINES;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
    throw new Error('--lines must be a positive integer');
  }
  return Number(raw);
}

/** Last `count` lines of a file, streamed backwards in one bounded read. */
async function tailLines(file: string, count: number): Promise<string> {
  const { size } = await stat(file);
  // Enough for ~4KiB/line worst case at the default depth; a full read is the
  // correct fallback for dense logs, and the file is a bounded daemon log.
  const window = Math.min(size, Math.max(64 * 1024, count * 4096));
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(window);
    const { bytesRead } = await handle.read(buffer, 0, window, size - window);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const tail = lines.slice(-count);
    return `${tail.join('\n')}\n`;
  } finally {
    await handle.close();
  }
}

async function follow(file: string): Promise<void> {
  let offset = (await stat(file)).size;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
    const { size } = await stat(file).catch(() => ({ size: offset }));
    if (size < offset) offset = 0; // truncated/rotated — start over
    if (size === offset) continue;
    const handle = await open(file, 'r');
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      offset += bytesRead;
      if (bytesRead > 0) process.stdout.write(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await handle.close();
    }
  }
}
