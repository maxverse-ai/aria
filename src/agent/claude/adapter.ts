import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildChannelEnv, type ChannelEnvContext } from '../channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { encodeUserMessageLine, extractUserEventText, translateEvent } from './stream-json';
import { armProcessExitDrain } from '../process-exit-drain';
import { buildAgentLaunchEnv } from '../launch-env';
import type {
  AgentSteeringOutcome,
  AgentSteeringRequest,
  AgentSteeringSupport,
} from '../steering';

export interface ClaudeAdapterOptions {
  binary?: string;
  systemPromptDirectory?: string;
  /** Override identity for Claude-compatible engines (e.g. Kimi). */
  id?: string;
  displayName?: string;
  /** Agent id reported by preflight; defaults to {@link id}. */
  agentId?: string;
  ariaChannel?: ChannelEnvContext;
  /**
   * 'auto' (default) steers by writing a mid-turn user message to the
   * persistent stream-json stdin; 'off' exposes no steering and defers all
   * mid-turn input to the next turn.
   */
  steering?: 'auto' | 'off';
}

type ClaudeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class ClaudeAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;

  private readonly binary: string;
  private readonly systemPromptDirectory?: string;
  private readonly agentId: string;
  private readonly ariaChannel: ChannelEnvContext | undefined;
  private readonly steeringEnabled: boolean;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.id = opts.id ?? 'claude';
    this.displayName = opts.displayName ?? 'Claude Code';
    this.agentId = opts.agentId ?? this.id;
    this.binary = opts.binary ?? 'claude';
    this.systemPromptDirectory = opts.systemPromptDirectory;
    this.ariaChannel = opts.ariaChannel;
    this.steeringEnabled = opts.steering !== 'off';
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: this.agentId,
      agentName: this.displayName,
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for ClaudeAdapter.run');
    }

    // The prompt and bridge system prompt must NOT go through argv. On Windows,
    // `claude` resolves to a `claude.cmd` shim and cross-spawn routes it through
    // `cmd.exe /d /s /c`, which interprets `<` and `>` as redirection operators
    // — that silently eats the prompt's `<bridge_context>` XML, so claude runs
    // with an empty request and replies with its default greeting instead of a
    // stream-json response. Pass the prompt via stdin and the appended system
    // prompt via a temp file (the same approach the Codex adapter uses) so no
    // special characters ever reach the shell.
    const systemPromptFile = writeSystemPromptFile(
      buildBridgeSystemPrompt(opts.identity, {
        // Only transports that can receive <steer_notice> need the contract.
        steerMailbox: CLAUDE_STEERING_SUPPORT.delivery === 'none',
      }),
      this.systemPromptDirectory,
    );

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
      '--append-system-prompt-file',
      systemPromptFile.path,
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: buildAgentLaunchEnv(buildChannelEnv(this.ariaChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ClaudeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    // Listeners MUST be attached synchronously here, before we return.
    // The 'error' and exit-related events can fire in the next tick; if we
    // defer attachment to the async-generator body, those events fire into
    // the void and the generator hangs.
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn claude: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
      systemPromptFile.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      systemPromptFile.cleanup();
    });
    // Mid-turn live input shares stdin with the initial prompt, so it stays
    // open for the run's lifetime and is closed when the turn's `result`
    // arrives — the process then exits on its own.
    const state: ClaudeRunState = {
      turnDone: false,
      stdinDead: false,
      lastToolEventMs: 0,
      pendingSteerTexts: new Map(),
    };
    const steeringRequests = new Map<string, Promise<AgentSteeringOutcome>>();
    const endStdin = (): void => {
      if (state.stdinDead) return;
      state.stdinDead = true;
      try {
        child.stdin.end();
      } catch {
        // The pipe may already be torn down; the exit path covers it.
      }
    };
    child.stdin.on('error', (err) => {
      state.stdinDead = true;
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.write(`${encodeUserMessageLine(opts.prompt)}\n`, 'utf8');

    const steering: AgentSteeringSupport | undefined = this.steeringEnabled
      ? CLAUDE_STEERING_SUPPORT
      : undefined;
    const steer = (request: AgentSteeringRequest): Promise<AgentSteeringOutcome> => {
      const existing = steeringRequests.get(request.requestId);
      if (existing) return existing;
      const attempt = performClaudeSteer(child, state, request, opts.runId);
      steeringRequests.set(request.requestId, attempt);
      return attempt;
    };

    // Default 5s if caller didn't specify — claude often has live
    // subprocesses (lark-cli waiting for OAuth, long Bash, etc.) and the
    // old 500ms was nowhere near enough for them to flush state before the
    // SIGKILL cascade. Callers (channel.ts, /doctor) override per-run with
    // a value derived from preferences.
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, state, endStdin),
      ...(steering ? { steering, steer } : {}),
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

interface ClaudeRunState {
  /** The turn's `result` event arrived — no further live input is possible. */
  turnDone: boolean;
  /** stdin errored or was closed; steers can no longer be written. */
  stdinDead: boolean;
  /** Last tool activity observed on stdout; a drop window follows it. */
  lastToolEventMs: number;
  /** Steered texts awaiting the CLI's user-event echo, keyed by requestId. */
  pendingSteerTexts: Map<string, string>;
}

async function* createEventStream(
  child: ClaudeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  state: ClaudeRunState,
  endStdin: () => void,
): AsyncGenerator<AgentEvent> {
  // If fork itself failed synchronously, child.pid is undefined. The 'error'
  // event (ENOENT etc.) fires in the next tick, so also check getError().
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn claude: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const cleanupProcessExitDrain = armProcessExitDrain(child, () => rl.close());
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
      const raw = parsed as {
        type?: string;
        message?: { content?: Array<{ type?: string }> };
      };
      // The window right after tool activity is where a stdin write can be
      // swallowed without a trace — timestamp tool blocks so steer can defer
      // instead. Plain text deltas must not arm the gate or every steer
      // would defer.
      const blocks = raw.message?.content;
      if (Array.isArray(blocks) && blocks.some(
        (block) => block?.type === 'tool_use' || block?.type === 'tool_result',
      )) {
        state.lastToolEventMs = Date.now();
      }
      // A `user` event that echoes a steered text back is the only delivery
      // evidence a stdio push produces: the CLI took the message into the
      // running turn.
      const echoed = extractUserEventText(parsed);
      if (echoed && state.pendingSteerTexts.size > 0) {
        for (const [requestId, needle] of state.pendingSteerTexts) {
          if (needle && echoed.includes(needle)) {
            state.pendingSteerTexts.delete(requestId);
            yield { type: 'steer_delivery', requestId, insertion: 'into-active-turn' };
          }
        }
      }
      if (raw.type === 'result') {
        state.turnDone = true;
        endStdin();
      }
      yield* translateEvent(parsed);
    }
  } finally {
    state.turnDone = true;
    endStdin();
    cleanupProcessExitDrain();
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `claude runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  // When the child is killed by a signal, exitCode stays null and signalCode
  // carries the name. Both must be checked or we'll attach an 'exit' listener
  // for an event that already fired and hang forever.
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `claude exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `claude runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
  }
}

/**
 * Persist the appended system prompt to a throwaway temp file so it can be
 * passed via `--append-system-prompt-file` instead of argv. Returns the path
 * plus an idempotent, best-effort cleanup that removes the temp directory.
 */
function writeSystemPromptFile(content: string, directory?: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(directory ?? tmpdir(), 'lark-claude-'));
  const path = join(dir, 'append-system-prompt.md');
  writeFileSync(path, content, 'utf8');
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}

/**
 * A stdin write gives no acknowledgement — a steered message can only be
 * confirmed if the CLI echoes it back as a `user` event, and even that says
 * nothing about drops. Delivery evidence is therefore 'none' at write time.
 */
const CLAUDE_STEERING_SUPPORT: AgentSteeringSupport = {
  mode: 'direct',
  textOnly: true,
  mechanism: 'stdio-push',
  delivery: 'none',
};

/**
 * How long after a tool event a stdin write is considered unsafe. Observed
 * claude builds drop input written right after a tool boundary; deferring
 * those steers to the next turn beats losing them silently.
 */
const POST_TOOL_GATE_MS = 750;

function performClaudeSteer(
  child: ClaudeChild,
  state: ClaudeRunState,
  request: AgentSteeringRequest,
  runId: string,
): Promise<AgentSteeringOutcome> {
  if (request.expectedRunId !== runId) {
    return Promise.resolve({ kind: 'rejected', reason: 'stale-run' });
  }
  const text = request.prompt.trim();
  if (!text) {
    return Promise.resolve({ kind: 'rejected', reason: 'invalid-input' });
  }
  if (state.turnDone || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ kind: 'deferred', reason: 'turn-closing' });
  }
  if (state.stdinDead) {
    return Promise.resolve({ kind: 'deferred', reason: 'turn-not-ready' });
  }
  if (Date.now() - state.lastToolEventMs < POST_TOOL_GATE_MS) {
    return Promise.resolve({ kind: 'deferred', reason: 'turn-not-ready' });
  }
  try {
    child.stdin.write(`${encodeUserMessageLine(request.prompt)}\n`, 'utf8');
  } catch (error) {
    return Promise.resolve({
      kind: 'rejected',
      reason: 'transport-error',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  }
  state.pendingSteerTexts.set(request.requestId, text);
  log.info('agent', 'steer-pushed', { runId, requestId: request.requestId });
  return Promise.resolve({
    kind: 'accepted',
    runId,
    insertion: 'unconfirmed',
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
