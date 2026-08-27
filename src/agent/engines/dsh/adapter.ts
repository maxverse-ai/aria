import type { Readable, Writable } from 'node:stream';
import { log } from '../../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../../platform/spawn';
import { SpawnFailed } from '../../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../../bridge-system-prompt';
import { buildChannelEnv, type ChannelEnvContext } from '../../channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../types';
import { buildDshArgs } from './argv';

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
  private readonly dshHome: string | undefined;
  private readonly defaultStopGraceMs: number;
  private readonly ariaChannel: ChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: DshAdapterOptions) {
    this.binary = opts.binary;
    this.dshHome = opts.dshHome;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.ariaChannel = opts.ariaChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
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
    const args = buildDshArgs(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity));
    const envOverrides: NodeJS.ProcessEnv = buildChannelEnv(this.ariaChannel);
    if (this.dshHome) envOverrides.DSH_HOME = this.dshHome;

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as DshChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(
        child,
        () => stdoutChunks,
        () => stderrChunks,
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
  getStderr: () => Buffer[],
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
  const exitCode = await waitForExitCode(child);
  const runtimeError = getError();
  if (exitCode !== 0 || runtimeError) {
    const stderr = Buffer.concat(getStderr()).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: runtimeError
        ? `dsh runtime error: ${runtimeError.message}`
        : `dsh exited with code ${exitCode}${detail}`,
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

async function waitForExitCode(child: DshChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}
