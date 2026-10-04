import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute, normalize, join } from 'node:path';
import { FileExecutionOwnership, type ExecutionOwnership, type ExecutionOwnershipLease } from '../ownership';
import type { ExecutionBackend, ExecutionEnvironment, ExecutionEnvironmentSpec } from '../types';
import type { ExecutionBackendAdapter } from './types';

export interface PodmanConfiguration {
  readonly binary: string;
  readonly image: string;
  readonly user: string;
  // Explicit deployment choice; bridge enables outbound networking, not an egress ACL.
  readonly network: 'none' | 'bridge';
  readonly memoryBytes: number;
  readonly cpus: number;
  readonly pids: number;
  readonly tmpBytes: number;
  readonly managerCwd: string;
  readonly managerEnv: Readonly<Record<string, string>>;
}
export type PodmanRunner = (args: readonly string[], signal?: AbortSignal) => Promise<{ code: number; stdout: string }>;
const ownerLabel = 'io.aria.execution.owner';
const revisionLabel = 'io.aria.execution.revision';
const generationLabel = 'io.aria.execution.generation';
// Rootless Podman may need several seconds to tear down its network namespace
// and attached exec helpers. Keep the grace period long enough for normal
// cleanup so a healthy worker is not incorrectly fenced as unrecoverable.
const spaceStopGraceSeconds = 35;
// Agent turns can outlive the short lifecycle commands; keep the manager
// subprocess alive for the same bounded window as the proof turn.
const podmanCommandTimeoutMs = 600_000;
const contains = (root: string, path: string) => path === root || path.startsWith(root + '/');
const pathValid = (path: string) => isAbsolute(path) && normalize(path) === path && !/[\0\n\r,:]/.test(path);
// Keep PID 1 signal-aware so a normal close does not spend the entire grace
// period waiting for `sleep infinity` to be killed. The child sleep keeps the
// holder idle without a busy loop; the trap lets Podman stop it promptly.
const spaceHolderScript = 'trap "exit 0" TERM INT; while :; do sleep 2147483647 & wait $!; done';

const persistedConfigurationKeys = ['binary', 'image', 'user', 'network', 'memoryBytes', 'cpus', 'pids', 'tmpBytes', 'managerCwd'] as const;

/** Persisted form of PodmanConfiguration: managerEnv is resolved at launch, never stored. */
export type PodmanPersistedConfiguration = Omit<PodmanConfiguration, 'managerEnv'>;

export function normalizePodmanPersistedConfiguration(value: unknown): PodmanPersistedConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !(persistedConfigurationKeys as readonly string[]).includes(k))) {
    throw new Error('invalid execution definition');
  }
  const configuration = structuredClone(value) as PodmanPersistedConfiguration;
  validatePodmanConfiguration({ ...configuration, managerEnv: {} });
  return configuration;
}

export function validatePodmanConfiguration(config: PodmanConfiguration): void {
  if (!config || !pathValid(config.binary) || !pathValid(config.managerCwd)
    || !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(config.image)
    || !/^[1-9][0-9]*:[1-9][0-9]*$/.test(config.user) || !['none', 'bridge'].includes(config.network)
    || ![config.memoryBytes, config.pids, config.tmpBytes].every(v => Number.isSafeInteger(v) && v > 0)
    || !Number.isFinite(config.cpus) || config.cpus <= 0
    || !config.managerEnv || Object.values(config.managerEnv).some(v => typeof v !== 'string' || v.includes('\0'))) {
    throw new Error('invalid Podman execution configuration');
  }
}

/** Runtime-specific mechanics only. Scheduling and idle ownership remain with Aria. */
export class PodmanExecutionBackend implements ExecutionBackend {
  readonly id = 'podman';
  private readonly opening = new Set<string>();
  private readonly runner: PodmanRunner;
  private readonly config: PodmanConfiguration;
  private readonly ownership: ExecutionOwnership;
  constructor(config: PodmanConfiguration, runner?: PodmanRunner, ownership?: ExecutionOwnership) {
    validatePodmanConfiguration(config);
    this.config = structuredClone(config);
    this.ownership = ownership ?? new FileExecutionOwnership(join(config.managerCwd, '.aria-execution-owners'));
    this.runner = runner ?? ((args, signal) => runPodman(this.config, args, signal));
  }
  async open(input: ExecutionEnvironmentSpec, signal?: AbortSignal): Promise<ExecutionEnvironment> {
    const spec = structuredClone(input);
    if (!/^[a-f0-9]{64}$/.test(spec.key) || !spec.revision || !pathValid(spec.cwd)
      || !spec.mounts.length || !spec.workingRoots.length
      || spec.mounts.some(m => !pathValid(m.source) || !pathValid(m.target) || m.source === '/' || m.target === '/')
      || spec.mounts.some(m => contains(m.source, join(this.config.managerCwd, '.aria-execution-owners')))
      || new Set(spec.mounts.map(m => m.target)).size !== spec.mounts.length
      || spec.workingRoots.some(root => !pathValid(root) || !spec.mounts.some(m => contains(m.target, root)))
      || !spec.workingRoots.some(root => contains(root, spec.cwd))) throw new Error('invalid execution environment specification');
    signal?.throwIfAborted();
    if (this.opening.has(spec.key)) throw new Error('Space execution environment is already acquired');
    this.opening.add(spec.key);
    const name = 'aria-space-' + spec.key;
    let lease: ExecutionOwnershipLease | undefined;
    const fingerprint = createHash('sha256').update(JSON.stringify({ spec, config: { ...this.config, managerEnv: undefined } })).digest('hex');
    const checked = async (args: readonly string[], abort?: AbortSignal) => {
      if (!lease?.healthy) throw new Error('execution ownership was lost');
      const result = await this.runner(args, abort);
      // An asynchronous manager command may outlive the lock helper. Its
      // success cannot authorize the next operation after ownership is lost.
      if (!lease.healthy) throw new Error('execution ownership was lost');
      if (result.code !== 0) throw new Error('Podman execution operation failed: ' + args[0]);
      return result.stdout;
    };
    const stopVerified = async () => {
      await checked(['stop', '--time', String(spaceStopGraceSeconds), name]);
      const records = JSON.parse(await checked(['inspect', name]));
      if (!Array.isArray(records) || records.length !== 1 || records[0]?.State?.Running !== false) {
        throw new Error('Space container stop could not be verified; recovery required');
      }
    };
    let acquired = false;
    try {
      lease = await this.ownership.acquire(spec.key);
      const previous = await lease.read();
      const exists = await this.runner(['container', 'exists', name], signal);
      if (!lease.healthy) throw new Error('execution ownership was lost');
      if (![0, 1].includes(exists.code)) throw new Error('cannot determine Space container ownership');
      let create = exists.code === 1;
      if (exists.code === 0) {
        const records = JSON.parse(await checked(['inspect', name], signal));
        const record = Array.isArray(records) && records.length === 1 ? records[0] : undefined;
        if (record?.Config?.Labels?.[ownerLabel] !== spec.key) throw new Error('existing Space container owner differs');
        if (!previous || record.Config.Labels[generationLabel] !== previous.generation) {
          throw new Error('Space container generation is not owned by this manager store');
        }
        // The kernel lock excludes the old manager. Fence surviving processes
        // before serving new tasks; never attach to their old native channels.
        if (record.State?.Running === true) await stopVerified();
        else if (record.State?.Running !== false) throw new Error('unknown Space container state');
        if (record.Config.Labels[revisionLabel] !== fingerprint) {
          await checked(['rm', name], signal);
          create = true;
        }
      }
      if (create) {
        const generation = randomUUID();
        await lease.write({ schema: 'aria.execution-owner.v1', key: spec.key, generation });
        // Map the manager's filesystem identity to the configured non-root
        // container identity; private bind mounts must not need relaxed modes.
        const [uid, gid] = this.config.user.split(':');
        await checked(['create', '--name', name, '--pull=never', '--read-only', '--cap-drop=ALL',
          '--security-opt=no-new-privileges', '--network=' + this.config.network, '--user', this.config.user,
          '--userns=keep-id:uid=' + uid + ',gid=' + gid,
          '--memory', String(this.config.memoryBytes), '--memory-swap', String(this.config.memoryBytes),
          '--cpus', String(this.config.cpus), '--pids-limit', String(this.config.pids),
          '--tmpfs', '/tmp:rw,nosuid,nodev,size=' + this.config.tmpBytes,
          '--label', ownerLabel + '=' + spec.key, '--label', revisionLabel + '=' + fingerprint,
          '--label', generationLabel + '=' + generation,
          ...spec.mounts.flatMap(m => ['--mount', 'type=bind,src=' + m.source + ',dst=' + m.target + (m.writable ? ',rw' : ',ro')]),
          '--entrypoint', '/bin/sh', this.config.image, '-c', spaceHolderScript, 'aria-space-holder'], signal);
      }
      acquired = true;
      await checked(['start', name], signal);
      await checked(['exec', name, '/bin/true'], signal);
      signal?.throwIfAborted();
    } catch (error) {
      // A timed-out start can leave a running instance. Keep ownership fenced if stopping fails.
      if (acquired) {
        try { await stopVerified(); }
        catch { throw new Error('Space container startup failed and cleanup requires recovery'); }
      }
      this.opening.delete(spec.key);
      await lease?.release();
      throw error;
    }
    let closed = false;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      await stopVerified();
      await lease!.release();
      closed = true; this.opening.delete(spec.key);
    })();
    // Failure stays observable through close(); event handlers must not create
    // unhandled rejections while the registry drains its existing borrowers.
    const invalidate = () => { void close().catch(() => {}); };
    return {
      id: name,
      isUsable: () => !closed && !closing && lease!.healthy,
      prepare: request => {
        if (closed || closing || !lease!.healthy) throw new Error('Space execution environment is closed');
        if (!pathValid(request.command) || !pathValid(request.cwd)
          || !spec.workingRoots.some(root => contains(root, request.cwd))) throw new Error('execution command escapes its Space');
        for (const [key, value] of Object.entries(request.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error('invalid execution environment variable');
        }
        // Use private transport variable names so task HOME/config cannot redirect the manager.
        // The generated shell contains only validated variable names; values never enter argv.
        const entries = Object.entries(request.env);
        const transport = Object.fromEntries(entries.map(([, value], index) => ['ARIA_EXEC_VALUE_' + index, value]));
        const script = 'exec /usr/bin/env -i ' + entries.map(([key], index) => key + '="$ARIA_EXEC_VALUE_' + index + '"').join(' ') + ' "$@"';
        return { command: this.config.binary,
          args: ['exec', '--interactive', '--workdir', request.cwd,
            ...Object.keys(transport).flatMap(key => ['--env', key]), name,
            '/bin/sh', '-c', script, 'aria-exec', request.command, ...request.args],
          cwd: this.config.managerCwd, env: { ...this.config.managerEnv, ...transport },
          onSpawn: child => {
            const kill = child.kill.bind(child);
            child.kill = signal => {
              if (signal !== 0) invalidate();
              return kill(signal);
            };
            child.once('error', invalidate);
            child.once('exit', (code, signal) => { if (code !== 0 || signal !== null) invalidate(); });
          },
          onSyncExit: result => { if (result.error || result.status !== 0 || result.signal) invalidate(); },
        };

      },
      close,
    };
  }
}

export const podmanBackendAdapter: ExecutionBackendAdapter<PodmanPersistedConfiguration> = {
  id: 'podman',
  normalizeConfiguration: normalizePodmanPersistedConfiguration,
  create: (configuration, managerEnv) => new PodmanExecutionBackend({ ...configuration, managerEnv }),
};

function runPodman(config: PodmanConfiguration, args: readonly string[], signal?: AbortSignal): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.binary, [...args], { cwd: config.managerCwd, env: config.managerEnv,
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal, timeout: podmanCommandTimeoutMs, killSignal: 'SIGKILL' });
    let stdout = '', bytes = 0;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) child.kill('SIGKILL'); else stdout += chunk; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => bytes > 1024 * 1024 ? reject(new Error('Podman response exceeded limit')) : resolve({ code: code ?? 125, stdout }));
  });
}
