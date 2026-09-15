import type { Readable, Writable } from 'node:stream';
import { log } from '../../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../../platform/spawn';
import { SpawnFailed } from '../../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../../bridge-system-prompt';
import { buildChannelEnv, type ChannelEnvContext } from '../../channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../../preflight';
import type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../types';
import { buildDshArgs } from './argv';
import { DshProgress, prepareDshProgress } from './progress';

export interface DshAdapterOptions {
  binary: string;
  profileStateDir: string;
  dshHome?: string;
  stopGraceMs?: number;
  ariaChannel?: ChannelEnvContext;
}

type DshChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'DeepSeek Harness';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly dshHome: string | undefined;
  private readonly defaultStopGraceMs: number;
  private readonly ariaChannel: ChannelEnvContext | undefined;

  constructor(opts: DshAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.dshHome = opts.dshHome;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.ariaChannel = opts.ariaChannel;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'dsh',
      agentName: 'DeepSeek Harness',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'dsh binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for DshAdapter.run');
    }
    const extension = prepareDshProgress(this.profileStateDir);
    const progress = new DshProgress();
    const args = buildDshArgs(prefixBridgeSystemPrompt(opts.prompt, opts.identity), extension.patch);
    const envOverrides: NodeJS.ProcessEnv = buildChannelEnv(this.ariaChannel);
    if (this.dshHome) envOverrides.DSH_HOME = this.dshHome;

    let child: DshChild;
    try {
      child = spawnProcess(this.binary, args, {
        cwd: opts.cwd,
        env: mergeProcessEnv(process.env, envOverrides),
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      }) as DshChild;
    } catch (error) {
      extension.cleanup();
      throw error;
    }

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let runtimeError: Error | null = null;
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error): void => {
      runtimeError ??= error;
      if (killTimer || child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, stopGraceMs);
      killTimer.unref();
    };
    const startupTimer = setTimeout(() => fail(new Error('DSH progress plugin initialization timed out')), 30_000);
    startupTimer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 8 * 1024 * 1024) stdoutChunks.push(chunk);
      else fail(new Error('DSH final answer exceeds limit'));
    });
    // Headless stderr contains provider reasoning. Drain it without retaining or
    // exposing it as an error message or progress event.
    child.stderr.resume();
    const progressPipe = child.stdio[3] as Readable;
    progressPipe.on('data', (chunk: Buffer) => {
      progress.push(chunk);
      if (progress.ready) clearTimeout(startupTimer);
      if (progress.error) fail(progress.error);
    });
    progressPipe.on('error', () => {
      fail(new Error('DSH progress pipe failed'));
    });
    const closed = new Promise<number | null>((resolve) => {
      child.once('close', (code) => {
        clearTimeout(startupTimer);
        clearTimeout(killTimer);
        progress.close();
        extension.cleanup();
        resolve(code);
      });
    });
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    return {
      runId: opts.runId,
      events: createEventStream(
        child,
        () => stdoutChunks,
        progress,
        closed,
        () => runtimeError,
      ),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: DshChild,
  getStdout: () => Buffer[],
  progress: DshProgress,
  closed: Promise<number | null>,
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn dsh: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }
  yield* progress.events();
  const exitCode = await closed;
  const runtimeError = getError() ?? progress.error ?? (!progress.ready ? new Error('DSH progress plugin did not initialize') : null);
  if (exitCode !== 0 || runtimeError) {
    yield {
      type: 'error',
      message: runtimeError
        ? `dsh runtime error: ${runtimeError.message}`
        : `dsh exited with code ${exitCode}`,
      terminationReason: 'failed',
    };
    return;
  }
  const answer = Buffer.concat(getStdout()).toString('utf8').trim();
  if (!answer) {
    yield {
      type: 'error',
      message: 'dsh finished without a final answer',
      terminationReason: 'failed',
    };
    return;
  }
  yield { type: 'final_text', content: answer };
  yield { type: 'done', terminationReason: 'normal' };
}
