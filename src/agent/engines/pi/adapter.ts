import { createInterface } from 'node:readline';
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
import { buildPiArgs } from './argv';
import { PiJsonlTranslator, type PiFinishReason } from './jsonl';

export interface PiAdapterOptions {
  binary: string;
  profileStateDir: string;
  sessionDir?: string;
  approve?: boolean;
  stopGraceMs?: number;
  ariaChannel?: ChannelEnvContext;
}

type PiChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'Pi';

  private readonly binary: string;
  private readonly sessionDir: string | undefined;
  private readonly approve: boolean;
  private readonly defaultStopGraceMs: number;
  private readonly ariaChannel: ChannelEnvContext | undefined;

  constructor(opts: PiAdapterOptions) {
    this.binary = opts.binary;
    this.sessionDir = opts.sessionDir;
    this.approve = opts.approve === true;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.ariaChannel = opts.ariaChannel;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'pi',
      agentName: 'Pi',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'pi binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for PiAdapter.run');
    }
    const prompt = prefixBridgeSystemPrompt(opts.prompt, opts.identity);
    // The prompt goes on stdin, matching this engine's declared
    // `promptInjection: 'stdin-prefix'` and the same fix the claude and codex
    // adapters carry: a Windows `.cmd` shim reaches the engine through cmd.exe,
    // which drops everything after the first newline of an argument. ARIA-PI-001.
    const args = buildPiArgs({
      sessionId: opts.sessionId,
      model: opts.model,
      thinking: opts.reasoningEffort,
      approve: this.approve,
      sessionDir: this.sessionDir,
    });
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildChannelEnv(this.ariaChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as PiChild;
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(prompt, 'utf8');

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    let stopReason: PiFinishReason | undefined;
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
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
  child: PiChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => PiFinishReason | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new PiJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn pi: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translator.translate(parsed);
    }
  } finally {
    rl.close();
  }
  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }
  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield* translator.fail(`pi exited with code ${exitCode}${detail}`);
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(`pi runtime error: ${runtimeError.message}`);
    return;
  }
  yield* translator.finish();
}

async function waitForExitCode(child: PiChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}
