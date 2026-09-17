import { snapshotParticipantIdentity, type ParticipantIdentity } from '../conversation/participant-identity';
import { withSourcePresentation } from '../conversation/presentation-context';
import type { RunTools, RunToolLease } from './run-tools';
import { bindAgentRun } from '../agent/runtime/bound-run';
import { bindRunAuthorization } from '../agent/runtime/run-authorization';
import type { AuthorizedSpaceContext } from '../space/authorization';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { observabilityFields } from '../observability/execution-context';
import { RunRejected, SpawnFailed } from './errors';
import { fixedAdapterRuntimeProvider, type RuntimeLease, type RuntimeProvider } from './runtime-provider';

export interface RunExecutorDeps {
  tools?: RunTools;
  agent: AgentAdapter;
  runtimeProvider?: RuntimeProvider;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
  audit?: RunAuditSink;
}

export interface RunAuditEvent {
  eventId: string;
  sourceRunId: string;
  action:
    | 'run.started'
    | 'run.completed'
    | 'run.failed'
    | 'run.interrupted'
    | 'run.timeout'
    | 'tool.started'
    | 'tool.completed';
  occurredAt: string;
  outcome: 'success' | 'failure';
  latencyMs?: number;
  errorCode?: string;
}

export interface RunAuditSink {
  record(event: RunAuditEvent): Promise<void>;
}

export interface SubmitRunInput {
  identity?: ParticipantIdentity;
  spaceContext?: AuthorizedSpaceContext;
  assertAuthorized?: () => void;
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly runtimeProvider: RuntimeProvider;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  private readonly audit?: RunAuditSink;
  private readonly tools?: RunTools;

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.runtimeProvider = deps.runtimeProvider ?? fixedAdapterRuntimeProvider(deps.agent);
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
    this.audit = deps.audit;
    this.tools = deps.tools;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const identity = snapshotParticipantIdentity(input.identity);
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const queuedDimensions = {
      ...observabilityFields(),
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'queued', {
      ...queuedDimensions,
      nowait: input.nowait === true,
      pool: this.pool.snapshot(),
    });

    let release: (() => void) | undefined;
    try { release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire(); }
    catch (error) { releaseScope(); throw error; }
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    let lease: RuntimeLease;
    try {
      lease = await this.runtimeProvider.acquire({ scopeId: input.scopeId, purpose: 'run', spaceContext: input.spaceContext, runId });
    } catch (error) {
      release(); releaseScope();
      throw new SpawnFailed('runtime acquisition failed', error, 'agent-prepare-failed');
    }
    let tools: RunToolLease | undefined;
    const releaseResources = (): void => {
      tools?.close();
      lease.release();
      if (release) { const once = release; release = undefined; once(); }
      releaseScope();
    };
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      identity,
      runId,
      scopeId: input.scopeId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    if (input.assertAuthorized) bindRunAuthorization(runOptions, input.assertAuthorized);
    const present = <T>(operation: () => T): T => withSourcePresentation(input.observability?.source, Boolean(input.spaceContext), operation,
      [lease.instructions, tools?.prompt].filter(Boolean).join('\n') || undefined);
    let run: AgentRun;
    try {
      if (input.policy.expiresAt <= this.now()) {
        throw new RunRejected('policy-expired', 'run policy expired while queued');
      }
      input.assertAuthorized?.();
      if (input.spaceContext) tools = await this.tools?.prepare(input.spaceContext, runId);
      await present(() => lease.runtime.execution.prepareRun?.(runOptions));
      input.assertAuthorized?.();
    } catch (err) {
      releaseResources();
      if (err instanceof RunRejected) throw err;
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (this.activeRuns.newRunsPaused()) {
      releaseResources();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      const native = bindAgentRun(present(() => lease.runtime.execution.run(runOptions)), present);
      run = input.assertAuthorized ? {
        runId: native.runId,
        events: native.events,
        get steering() {
          return native.steering;
        },
        ...(native.steer ? { steer: (request) => {
          input.assertAuthorized!(); return native.steer!(request);
        } } : {}),
        stop: () => native.stop(), waitForExit: (timeout) => native.waitForExit(timeout),
      } : native;
    } catch (err) {
      releaseResources();
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      ...observabilityFields(),
      runId,
      ...queuedDimensions,
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
      releaseScope();
    } catch (err) {
      await run.stop().catch(() => {});
      releaseResources();
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    await this.recordAudit({
      eventId: `${runId}:started`, sourceRunId: runId, action: 'run.started',
      occurredAt: new Date(startedAt).toISOString(), outcome: 'success',
    });
    return this.buildExecution({ run, runId, scopeId: input.scopeId, handle, startedAt, dimensions, releaseResources });
  }

  /**
   * Wraps a run this process did not start — an engine-started goal
   * continuation — in the same execution shape `submit` returns, so the
   * ordinary consumers (audit, stop, subscription) need no special case.
   */
  async adopt(input: {
    run: AgentRun;
    scopeId: string;
    observability?: { profile?: string; agent?: string; source?: string };
  }): Promise<RunExecution> {
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }
    const { run } = input;
    const runId = run.runId;
    const startedAt = this.now();
    const dimensions = {
      ...observabilityFields(),
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: 'engine-turn',
    };
    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
      releaseScope();
    } catch (err) {
      await run.stop().catch(() => {});
      releaseScope();
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    await this.recordAudit({
      eventId: `${runId}:started`, sourceRunId: runId, action: 'run.started',
      occurredAt: new Date(startedAt).toISOString(), outcome: 'success',
    });
    return this.buildExecution({
      run, runId, scopeId: input.scopeId, handle, startedAt, dimensions,
      releaseResources: () => undefined,
    });
  }

  private buildExecution(input: {
    run: AgentRun;
    runId: string;
    scopeId: string;
    handle: RunHandle;
    startedAt: number;
    dimensions: Record<string, unknown>;
    releaseResources: () => void;
  }): RunExecution {
    const { run, runId, scopeId, handle, startedAt, dimensions, releaseResources } = input;
    let cleanupPromise: Promise<void> | undefined;
    let stopWork: Promise<void> | undefined;
    let exitWork: Promise<boolean> | undefined;
    const waitForNativeExit = () => exitWork ??= run.waitForExit(this.postDoneExitGraceMs);
    const cleanup = (waitForExit: boolean): Promise<void> => {
      cleanupPromise ??= (async () => {
        try {
          if (stopWork) await stopWork;
          if (waitForExit) {
            const exited = await waitForNativeExit();
            if (!exited) {
              log.warn('run', 'post-done-exit-timeout', {
                ...dimensions,
                graceMs: this.postDoneExitGraceMs,
              });
              await run.stop().catch((err) => {
                log.warn('run', 'post-done-stop-failed', {
                  ...dimensions,
                  err: err instanceof Error ? err.message : String(err),
                });
              });
            }
          }
          if (stopWork) await stopWork;
        } finally {
          this.activeRuns.unregister(scopeId, run);
          releaseResources();
        }
      })();
      return cleanupPromise;
    };
    let terminalAudited = false;
    const recordTerminal = async (reason: 'normal' | 'failed' | 'interrupted' | 'timeout'): Promise<void> => {
      if (terminalAudited) return;
      terminalAudited = true;
      const terminalAt = this.now();
      const action: RunAuditEvent['action'] = reason === 'normal' ? 'run.completed' : `run.${reason}`;
      await this.recordAudit({
        eventId: `${runId}:${reason}`, sourceRunId: runId, action,
        occurredAt: new Date(terminalAt).toISOString(),
        outcome: reason === 'normal' ? 'success' : 'failure',
        latencyMs: Math.max(0, terminalAt - startedAt),
        ...(reason === 'normal' ? {} : { errorCode: reason.toUpperCase() }),
      });
    };
    const fanout = new EventFanout(observeRunEvents(run.events, {
      dimensions,
      sourceRunId: runId,
      startedAt,
      now: this.now,
      recordAudit: (event) => this.recordAudit(event),
      recordTerminal,
    }), async () => {
      await cleanup(!handle.interrupted);
    });
    fanout.start();

    return {
      runId,
      scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      stop: async () => {
        handle.interrupted = true;
        stopWork ??= (async () => {
          await run.stop();
          await waitForNativeExit();
          await recordTerminal('interrupted');
        })();
        try { await stopWork; } finally { await cleanup(false); }
      },
    };
  }

  private async recordAudit(event: RunAuditEvent): Promise<void> {
    if (!this.audit) return;
    await this.audit.record(event).catch((err) =>
      log.warn('run', 'audit-write-failed', {
        runId: event.sourceRunId,
        action: event.action,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    sourceRunId: string;
    startedAt: number;
    now: () => number;
    recordAudit(event: RunAuditEvent): Promise<void>;
    recordTerminal(reason: 'normal' | 'failed' | 'interrupted' | 'timeout'): Promise<void>;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      const toolStartedAt = new Map<string, number>();
      const auditedToolStarts = new Set<string>();
      const auditedToolResults = new Set<string>();
      for await (const event of events) {
        if (event.type === 'tool_use' && !auditedToolStarts.has(event.id)) {
          auditedToolStarts.add(event.id);
          const occurredAt = opts.now();
          toolStartedAt.set(event.id, occurredAt);
          await opts.recordAudit({
            eventId: `${opts.sourceRunId}:tool:${event.id}:started`,
            sourceRunId: opts.sourceRunId,
            action: 'tool.started',
            occurredAt: new Date(occurredAt).toISOString(),
            outcome: 'success',
          });
        }
        if (event.type === 'tool_result' && !auditedToolResults.has(event.id)) {
          auditedToolResults.add(event.id);
          const occurredAt = opts.now();
          const startedAt = toolStartedAt.get(event.id);
          await opts.recordAudit({
            eventId: `${opts.sourceRunId}:tool:${event.id}:completed`,
            sourceRunId: opts.sourceRunId,
            action: 'tool.completed',
            occurredAt: new Date(occurredAt).toISOString(),
            outcome: event.isError ? 'failure' : 'success',
            ...(startedAt !== undefined ? { latencyMs: Math.max(0, occurredAt - startedAt) } : {}),
            ...(event.isError ? { errorCode: 'TOOL_ERROR' } : {}),
          });
        }
        if (event.type === 'done') {
          await opts.recordTerminal(event.terminationReason);
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          await opts.recordTerminal(event.terminationReason);
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private error: unknown;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>) {
    this.source = source;
    this.onDone = onDone;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      this.error = err;
    } finally {
      try { await this.onDone(); }
      catch (error) { this.error ??= error; }
      finally { this.done = true; this.wakeAll(); }
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
