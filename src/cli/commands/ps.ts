import { SUPERVISOR_SERVICE_ID } from '../../daemon/paths';
import { getServiceAdapter } from '../../daemon/service-adapter';
import { readAndPrune, resolveTarget, isAlive } from '../../runtime/registry';
import type { ProcessEntry } from '../../runtime/registry';

/**
 * Pretty-print the list of running aria processes.
 *
 * `readAndPrune` is a legacy name; read-only views never rewrite registry
 * state. Persistence happens on the next `register` / `unregister` /
 * `updateEntry` call.
 */
export interface PsCliOptions {
  json?: boolean;
}

export function runPs(opts: PsCliOptions = {}): void {
  const live = readAndPrune();
  if (opts.json) {
    console.log(
      JSON.stringify({ schema: 'aria.ps.v1', apiVersion: 1, processes: live }, null, 2),
    );
    return;
  }
  if (live.length === 0) {
    console.log('当前没有 bot 在运行。');
    return;
  }
  console.log(`# 当前共 ${live.length} 个 bot 在运行\n`);
  const rows = live.map((e, idx) => {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const app = e.botName ? `${e.botName} (${e.appId})` : e.appId;
    return {
      idx: String(idx + 1),
      id: e.id,
      pid: String(e.pid),
      app,
      started: ago,
      version: e.version,
    };
  });
  const headers = { idx: '#', id: 'ID', pid: 'PID', app: 'Bot', started: '启动', version: '版本' };
  printTable([headers, ...rows]);
}

export async function runKillCli(target: string | undefined, opts: PsCliOptions = {}): Promise<void> {
  const fail = (error: string, extra: Record<string, unknown> = {}): never => {
    if (opts.json) {
      console.log(JSON.stringify({ schema: 'aria.kill.v1', apiVersion: 1, ok: false, error, ...extra }, null, 2));
    } else {
      console.error(error);
    }
    process.exit(1);
  };
  if (!target) {
    fail('usage: aria kill <bot id or #>');
  }
  const entry = resolveTarget(target!);
  if (!entry) {
    fail(`no matching bot: ${target}`, { hint: 'run `aria ps` to list targets' });
  }
  const owner = findOwningService(entry!);
  if (owner) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          { schema: 'aria.kill.v1', apiVersion: 1, ok: false,
            error: `bot ${entry!.id} (pid ${entry!.pid}) is owned by ${owner.platformName}; SIGTERM is restarted within seconds`,
            owner },
          null,
          2,
        ),
      );
      process.exit(1);
    }
    console.error(
      `✗ bot ${entry!.id} (pid ${entry!.pid}) 由 ${owner.platformName} 托管,` +
        'SIGTERM 之后会被服务管理器立刻重启。',
    );
    console.error(`  要停掉它:  ${owner.stopHint}`);
    console.error(`  只是想重启: ${owner.restartHint}`);
    process.exit(1);
  }

  const result = await stopProcessEntry(entry!).catch((err: unknown) =>
    fail(`stop failed: ${(err as Error).message}`),
  );

  if (opts.json) {
    console.log(
      JSON.stringify(
        { schema: 'aria.kill.v1', apiVersion: 1, ok: true, id: entry!.id, pid: entry!.pid, result },
        null,
        2,
      ),
    );
    return;
  }
  if (result === 'killed') {
    console.log(`✓ 已强制关闭 bot ${entry!.id}。`);
    return;
  }
  console.log(`✓ 已关闭 bot ${entry!.id}。`);
}

/**
 * Detect that a registry entry IS the process an OS service manager owns.
 *
 * launchd (KeepAlive) / systemd (Restart) / Task Scheduler treat a SIGTERM'd
 * daemon as a crash and respawn it within seconds, on a fresh pid — so a plain
 * `kill` reports "✓ 已关闭" and the bot is back before the user can blink.
 * Both service shapes are checked: the machine-wide supervisor (whose pid is
 * shared by every profile it hosts in-process) and a classic per-profile one.
 */
function findOwningService(
  entry: ProcessEntry,
): { platformName: string; stopHint: string; restartHint: string } | undefined {
  const candidates = [
    { serviceId: SUPERVISOR_SERVICE_ID, flag: '--web-ui' },
    { serviceId: entry.profileName, flag: `--profile ${entry.profileName}` },
  ];
  for (const { serviceId, flag } of candidates) {
    const adapter = getServiceAdapter(serviceId);
    if (!adapter?.fileExists() || !adapter.isRunning()) continue;
    const { pid } = adapter.parseStatus(adapter.describeStatus());
    if (!pid || Number(pid) !== entry.pid) continue;
    return {
      platformName: adapter.platformName,
      stopHint: `aria stop ${flag}`,
      restartHint: `aria restart ${flag}`,
    };
  }
  return undefined;
}

export type StopProcessEntryResult = 'terminated' | 'killed';

export async function stopProcessEntry(
  entry: Pick<ProcessEntry, 'pid'> & { id?: string },
  timeoutMs = 2000,
): Promise<StopProcessEntryResult> {
  process.kill(entry.pid, 'SIGTERM');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(entry.pid)) {
      return 'terminated';
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  process.kill(entry.pid, 'SIGKILL');
  const forceDeadline = Date.now() + timeoutMs;
  while (Date.now() < forceDeadline) {
    if (!isAlive(entry.pid)) {
      return 'killed';
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`process ${entry.pid} did not exit after SIGKILL`);
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

/** Minimal fixed-width table. Header row is index 0. */
function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  const headerRow = rows[0];
  if (!headerRow) return;
  const cols = Object.keys(headerRow);
  const widths: Record<string, number> = {};
  for (const col of cols) {
    widths[col] = Math.max(...rows.map((r) => displayWidth(r[col] ?? '')));
  }
  for (const r of rows) {
    const line = cols
      .map((c) => padEndDisplay(r[c] ?? '', widths[c] ?? 0))
      .join('  ');
    console.log(line);
  }
}

function displayWidth(s: string): number {
  // Approximate — CJK chars take 2 cells. Avoids pulling in wcwidth.
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 0x2e80 ? 2 : 1;
  }
  return w;
}

function padEndDisplay(s: string, target: number): string {
  const pad = target - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}
