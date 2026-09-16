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

/**
 * The outcome of a version probe.
 *
 * A binary can be present and still fail to report a version, and the three
 * ways that happens — timeout, non-zero exit, silent output — used to collapse
 * into the same `undefined`, which made an intermittent failure impossible to
 * diagnose from a test report. Record which one it was.
 */
interface VersionProbe {
  version?: string;
  failure?: string;
}

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
          const probe = await readVersion(binaryPath);
          return {
            id: plugin.id,
            displayName: plugin.displayName,
            installed: true,
            binaryPath,
            version: probe.version,
            ...(probe.failure ? { error: probe.failure } : {}),
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

/**
 * Read a version, tolerating one transient spawn failure.
 *
 * This is a mitigation, not a fix: an intermittent probe failure on a loaded CI
 * host was observed as "installed but no version" with the child failing fast.
 * A second attempt cannot hide a persistent problem — a binary that genuinely
 * cannot report a version fails both times — and the recorded `failure` still
 * names what the last attempt saw. A timeout is not retried, because it has
 * already spent the whole budget.
 */
async function readVersion(binaryPath: string): Promise<VersionProbe> {
  const first = await readVersionOnce(binaryPath);
  if (!first.failure || first.failure.startsWith("version probe timed out")) return first;
  return readVersionOnce(binaryPath);
}

function readVersionOnce(binaryPath: string): Promise<VersionProbe> {
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
        resolve({ failure: `version probe timed out after ${VERSION_TIMEOUT_MS}ms` });
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
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const detail = stderr.trim().split('\n')[0]?.trim();
        resolve({
          failure: `version probe exited with code ${code}${signal ? ` (${signal})` : ''}`
            + (detail ? `: ${detail}` : ''),
        });
        return;
      }
      const version = (stdout.trim() || stderr.trim()).split('\n')[0]?.trim();
      resolve(version ? { version } : { failure: 'version probe produced no output' });
    });
  });
}
