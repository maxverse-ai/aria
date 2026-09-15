import { resolveExecutablePath } from '../../platform/executable';
import { spawnProcess } from '../../platform/spawn';
import { listEnginePlugins } from './registry';

export interface EngineProbeStatus {
  id: string;
  displayName: string;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  error?: string;
  checkedAt: number;
}

const PROBE_TTL_MS = 60_000;
// A version probe only reads a flag, but a cold engine binary on a loaded or
// virtualized host can take well over five seconds to start. Timing out turns
// "slow" into "not installed", so allow for a slow start while still bounding
// a genuinely hung binary.
const VERSION_TIMEOUT_MS = 30_000;

const cache = new Map<string, EngineProbeStatus>();
let inflight: Promise<EngineProbeStatus[]> | undefined;

/**
 * Return the last known catalog immediately, even when its TTL has expired.
 * Interactive flows use this stale snapshot for instant feedback; only the
 * runtime supervisor decides whether a selected engine is actually usable.
 */
export function snapshotEngineStatus(): EngineProbeStatus[] {
  return listEnginePlugins().map((plugin) =>
    cache.get(plugin.id) ?? {
      id: plugin.id,
      displayName: plugin.displayName,
      installed: false,
      error: 'not probed in this process',
      checkedAt: 0,
    },
  );
}

/** Probe installed engine CLIs, cached for {@link PROBE_TTL_MS}. */
export async function probeEngineStatus(force = false): Promise<EngineProbeStatus[]> {
  const now = Date.now();
  if (!force && inflight) return inflight;
  if (
    !force &&
    cache.size === listEnginePlugins().length &&
    [...cache.values()].every((status) => now - status.checkedAt < PROBE_TTL_MS)
  ) {
    return [...cache.values()];
  }

  inflight = (async () => {
    const statuses = await Promise.all(
      listEnginePlugins().map(async (plugin) => {
        const probe = plugin.probes[0];
        const command =
          (probe?.envKey ? process.env[probe.envKey] : undefined) ??
          probe?.command ??
          plugin.id;
        try {
          const binaryPath = await resolveExecutablePath(command);
          const version = await readVersion(binaryPath);
          return {
            id: plugin.id,
            displayName: plugin.displayName,
            installed: true,
            binaryPath,
            version,
            checkedAt: Date.now(),
          } satisfies EngineProbeStatus;
        } catch (err) {
          return {
            id: plugin.id,
            displayName: plugin.displayName,
            installed: false,
            error: err instanceof Error ? err.message : String(err),
            checkedAt: Date.now(),
          } satisfies EngineProbeStatus;
        }
      }),
    );
    cache.clear();
    for (const status of statuses) cache.set(status.id, status);
    return statuses;
  })();

  try {
    return await inflight;
  } finally {
    inflight = undefined;
  }
}

function readVersion(binaryPath: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binaryPath, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    }, VERSION_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      const version = (stdout.trim() || stderr.trim()).split('\n')[0]?.trim();
      resolve(version || undefined);
    });
  });
}
