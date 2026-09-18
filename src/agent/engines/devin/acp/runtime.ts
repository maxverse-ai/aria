import { assertRunAuthorization } from '../../../runtime/run-authorization';
import { registerRuntimeQueries } from '../../../runtime/queries';
import { listDevinSessionsWithClient } from '../history';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AccessMode } from '../../../../config/permissions';
import { checkAgentAvailability, type AgentAvailability } from '../../../preflight';
import {
  defineEngineRuntimeDescriptor,
  type EngineRuntime,
} from '../../../runtime/types';
import type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../../types';
import type {
  AgentSteeringInsertion,
  AgentSteeringOutcome,
  AgentSteeringRequest,
  AgentSteeringSupport,
} from '../../../steering';
import { log } from '../../../../core/logger';
import { prefixBridgeSystemPrompt } from '../../../bridge-system-prompt';
import type { ChannelEnvContext } from '../../../channel-env';
import {
  DevinRpcError,
  DevinServerRequestError,
  type DevinAcpClient,
} from './client';
import { DevinMessageTranslator } from './message-translator';
import {
  extractDevinUsage,
  extractSessionId,
  extractUserMessageId,
  findConfigOption,
  isRecord,
  negotiatedSteeringMethod,
  type DevinJsonRpcNotification,
  type DevinJsonRpcRequest,
  type DevinPromptResult,
  type DevinSessionResult,
  type DevinSessionUpdateParams,
  type DevinSteeringMethod,
} from './protocol';
import { resolveDevinApiKey, startDevinAcp } from './process';

export interface DevinAcpRuntimeOptions {
  binary: string;
  profileStateDir: string;
  access: AccessMode;
  model?: string;
  apiKeyEnv?: string;
  ariaChannel?: ChannelEnvContext;
  /**
   * 'auto' (default) steers by merging a second session/prompt into the
   * active turn; 'off' exposes no steering and defers all mid-turn input.
   */
  steering?: 'auto' | 'off';
}

/** Aria access level → Devin ACP session mode id candidates. */
const ACCESS_MODE_CANDIDATES: Record<AccessMode, readonly string[]> = {
  'read-only': ['plan'],
  workspace: ['accept-edits', 'acceptEdits', 'accept_edits'],
  full: ['dangerous', 'bypass', 'yolo'],
};

export class DevinAcpRuntime implements EngineRuntime {
  readonly engineId = 'devin';
  readonly descriptor = defineEngineRuntimeDescriptor({
    engineId: this.engineId,
    topology: 'profile-daemon',
    capabilities: {
      inputs: ['text', 'image'],
      liveInput: { mode: 'direct', inputs: ['text'] },
      sessions: ['resume', 'list'],
      controls: ['interrupt', 'model'],
      interactions: [],
      telemetry: ['usage'],
    },
  });
  readonly execution: AgentAdapter;

  private clientPromise: Promise<DevinAcpClient> | undefined;
  private disposed = false;
  private readonly activeRuns = new Set<DevinAgentRun>();
  private readonly activeSessions = new Map<string, DevinAgentRun>();

  constructor(private readonly options: DevinAcpRuntimeOptions) {
    this.execution = new DevinAcpAdapter(this);
    registerRuntimeQueries(this, {
      listHistory: async (input) => listDevinSessionsWithClient(await this.client(), input),
    });
  }

  async client(): Promise<DevinAcpClient> {
    if (this.disposed) throw new Error('devin acp runtime is disposed');
    if (!this.clientPromise) {
      const apiKey = resolveDevinApiKey(this.options.apiKeyEnv);
      const started = startDevinAcp({
        binary: this.options.binary,
        cwd: this.options.profileStateDir,
        profileStateDir: this.options.profileStateDir,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.ariaChannel ? { ariaChannel: this.options.ariaChannel } : {}),
        auth: {
          apiKeyEnv: apiKey.envKey,
          ...(apiKey.key ? { apiKey: apiKey.key } : {}),
          requireAuth: true,
        },
        handleServerRequest: (request) => this.handleServerRequest(request),
      });
      this.clientPromise = started;
      void started.then(
        (client) => {
          client.onClosed(() => {
            if (this.clientPromise === started) this.clientPromise = undefined;
          });
        },
        () => {
          if (this.clientPromise === started) this.clientPromise = undefined;
        },
      );
    }
    return this.clientPromise;
  }

  track(run: DevinAgentRun): void {
    this.activeRuns.add(run);
  }

  untrack(run: DevinAgentRun): void {
    this.activeRuns.delete(run);
    if (run.currentSessionId && this.activeSessions.get(run.currentSessionId) === run) {
      this.activeSessions.delete(run.currentSessionId);
    }
  }

  bindSession(sessionId: string, run: DevinAgentRun): void {
    const existing = this.activeSessions.get(sessionId);
    if (existing && existing !== run) throw new Error('Devin session is already owned by another active run');
    this.activeSessions.set(sessionId, run);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const clientPromise = this.clientPromise;
    const runs = [...this.activeRuns];
    await Promise.allSettled(runs.map((run) => run.stop()));
    await Promise.allSettled(runs.map((run) => run.waitForExit(1_000)));
    const client = await clientPromise?.catch(() => undefined);
    await client?.dispose();
    this.activeRuns.clear();
    this.activeSessions.clear();
  }

  availability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'devin',
      agentName: 'Devin',
      command: this.options.binary,
      binaryPath: this.options.binary,
      args: ['version'],
    });
  }

  get fullAccess(): boolean {
    return this.options.access === 'full';
  }

  get access(): AccessMode {
    return this.options.access;
  }

  get steeringDisabled(): boolean {
    return this.options.steering === 'off';
  }

  private async handleServerRequest(request: DevinJsonRpcRequest): Promise<unknown> {
    if (request.method !== 'session/request_permission') {
      throw new DevinServerRequestError(`unsupported Devin ACP server request: ${request.method}`);
    }
    const params = isRecord(request.params) ? request.params : undefined;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined;
    if (!sessionId || !this.activeSessions.has(sessionId)) {
      throw new DevinServerRequestError('Devin permission request does not match an active session', -32602);
    }
    const desiredKind = this.activeSessions.get(sessionId)!.allowsPermission() ? 'allow_once' : 'reject_once';
    const option = Array.isArray(params?.options)
      ? params.options.find((candidate) => isRecord(candidate) && candidate.kind === desiredKind)
      : undefined;
    if (!isRecord(option) || typeof option.optionId !== 'string') {
      throw new DevinServerRequestError(
        `Devin permission request does not offer ${desiredKind}`,
        -32602,
      );
    }
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }
}

class DevinAcpAdapter implements AgentAdapter {
  readonly id = 'devin';
  readonly displayName = 'Devin';

  constructor(private readonly runtime: DevinAcpRuntime) {}

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  checkAvailability(): Promise<AgentAvailability> {
    return this.runtime.availability();
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) throw availability.error;
    await this.runtime.client();
  }

  run(options: AgentRunOptions): AgentRun {
    if (!options.cwd) throw new Error('cwd is required for Devin');
    const run = new DevinAgentRun(this.runtime, options);
    this.runtime.track(run);
    return run;
  }
}

type RunSignal =
  | { type: 'notification'; notification: DevinJsonRpcNotification; replay: boolean }
  | { type: 'prompt-result'; result: DevinPromptResult }
  | { type: 'prompt-error'; error: Error }
  | { type: 'steer-delivery' }
  | { type: 'closed'; error: Error };

const DEVIN_STEERING_SUPPORT: AgentSteeringSupport = {
  mode: 'direct',
  textOnly: true,
  mechanism: 'prompt-merge',
  delivery: 'inferred',
};

/**
 * A negotiated steering RPC (`session/inject` or `_session/steering`) gets a
 * real response, so delivery evidence is confirmed rather than inferred.
 */
const DEVIN_STEERING_EXTENSION_SUPPORT: AgentSteeringSupport = {
  mode: 'direct',
  textOnly: true,
  mechanism: 'acp-extension',
  delivery: 'confirmed',
};

/**
 * A merged session/prompt only resolves when a turn completes, so a refused
 * steer is told apart from an absorbed one by timing: a protocol error lands
 * immediately, while silence within this window means the engine took it.
 */
const STEER_DISPATCH_GRACE_MS = 750;
/**
 * Like the primary prompt, a merged steer has no transport deadline — it
 * settles when a turn ends, which may be far in the future.
 */
const STEER_PROMPT_TIMEOUT_MS = 0;
/**
 * Bounded wait for steer prompt results when the owning turn finishes.
 * Merged steers resolve together with the turn; a steer that became a turn
 * of its own may still be pending — those stay log-only.
 */
const STEER_RESULT_SETTLE_MS = 500;

export class DevinAgentRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  private sessionId: string | undefined;
  private client: DevinAcpClient | undefined;
  private queue: RunQueue | undefined;
  private promptInFlight = false;
  private stopRequested = false;
  private turnClosing = false;
  private exited = false;
  private turnUserMessageId: string | undefined;
  private readonly steeringRequests = new Map<string, Promise<AgentSteeringOutcome>>();
  /** In-flight steer prompt requests, keyed by steering requestId. */
  private readonly steerAttempts = new Map<string, Promise<DevinPromptResult>>();
  /** Steer prompt results parked until the turn's own userMessageId is known. */
  private readonly steerResults = new Map<string, DevinPromptResult>();
  /** Classified steer deliveries waiting to be emitted as stream events. */
  private readonly steerDeliveries: Array<{
    requestId: string;
    insertion: AgentSteeringInsertion | 'failed';
  }> = [];
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  allowsPermission(): boolean {
    assertRunAuthorization(this.options);
    return this.runtime.fullAccess && (this.options.sandbox === undefined || this.options.sandbox === 'danger-full-access');
  }

  constructor(
    private readonly runtime: DevinAcpRuntime,
    private readonly options: AgentRunOptions,
  ) {
    this.runId = options.runId;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.events = this.stream();
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  get steering(): AgentSteeringSupport | undefined {
    const initializeResult = this.client?.initializeResult;
    if (!initializeResult || this.runtime.steeringDisabled) return;
    if (this.steeringMethod(this.client)) return DEVIN_STEERING_EXTENSION_SUPPORT;
    return DEVIN_STEERING_SUPPORT;
  }

  /**
   * Negotiated capability is trusted only until the wire contradicts it: an
   * extension that answers -32601 was advertised but not implemented, so
   * subsequent steers fall back to prompt-merge for this run.
   */
  private extensionSteeringRefused = false;

  private steeringMethod(client: DevinAcpClient | undefined): DevinSteeringMethod | undefined {
    if (!client || this.extensionSteeringRefused) return;
    return negotiatedSteeringMethod(client.initializeResult);
  }

  steer(request: AgentSteeringRequest): Promise<AgentSteeringOutcome> {
    const existing = this.steeringRequests.get(request.requestId);
    if (existing) return existing;
    const attempt = this.performSteer(request);
    this.steeringRequests.set(request.requestId, attempt);
    return attempt;
  }

  /**
   * Devin ACP exposes no named steering method, but a second session/prompt
   * issued while a turn is running merges into that turn. The request is not
   * awaited like an ordinary prompt — its result only arrives when a turn
   * ends — so dispatch it and race a short grace window: an immediate
   * protocol error means the input was refused (defer it for the next turn),
   * silence means the engine absorbed it. Actual landing (merge vs. new
   * turn) is classified later by comparing userMessageId metadata and
   * surfaced as a steer_delivery event.
   */
  private async performSteer(request: AgentSteeringRequest): Promise<AgentSteeringOutcome> {
    if (request.expectedRunId !== this.runId) {
      return { kind: 'rejected', reason: 'stale-run' };
    }
    if (!request.prompt.trim()) {
      return { kind: 'rejected', reason: 'invalid-input' };
    }
    if (this.turnClosing || this.stopRequested || this.exited) {
      return { kind: 'deferred', reason: 'turn-closing' };
    }
    if (!this.steering) return { kind: 'deferred', reason: 'unsupported' };
    const client = this.client;
    const sessionId = this.sessionId;
    if (!client || !sessionId || !this.promptInFlight) {
      return { kind: 'deferred', reason: 'turn-not-ready' };
    }

    const method = this.steeringMethod(client);
    if (method) {
      return this.performSteerExtension(request, method, client, sessionId);
    }

    const attempt = client.request<DevinPromptResult>('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: request.prompt }],
    }, STEER_PROMPT_TIMEOUT_MS);
    this.steerAttempts.set(request.requestId, attempt);
    attempt.then(
      (result) => this.onSteerSettled(request.requestId, result),
      (error: unknown) => this.onSteerSettled(
        request.requestId,
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
    return Promise.race<AgentSteeringOutcome>([
      attempt.then(
        (result): AgentSteeringOutcome => ({
          kind: 'accepted',
          runId: this.runId,
          insertion: this.classifySteerResult(result),
        }),
        (error: unknown): AgentSteeringOutcome => steerErrorOutcome(error),
      ),
      new Promise<AgentSteeringOutcome>((resolve) => {
        setTimeout(
          () => resolve({ kind: 'accepted', runId: this.runId, insertion: 'unconfirmed' }),
          STEER_DISPATCH_GRACE_MS,
        );
      }),
    ]);
  }

  /**
   * Negotiated steering path: unlike prompt-merge the RPC answers directly,
   * so the response itself is the delivery evidence. `session/inject`
   * (RFD #1261) takes a mode and returns an agent-owned messageId;
   * `_session/steering` reports `injected` / `startedNewTurn`. Both map onto
   * the same insertion classification, recorded immediately so the stream
   * emits steer_delivery without waiting for the turn to end.
   */
  private async performSteerExtension(
    request: AgentSteeringRequest,
    method: DevinSteeringMethod,
    client: DevinAcpClient,
    sessionId: string,
  ): Promise<AgentSteeringOutcome> {
    try {
      const params: Record<string, unknown> = {
        sessionId,
        prompt: [{ type: 'text', text: request.prompt }],
      };
      if (method === 'session/inject') params.mode = 'steer';
      const result = await client.request<unknown>(method, params);
      const insertion = classifyExtensionSteerResult(result);
      this.steerDeliveries.push({ requestId: request.requestId, insertion });
      this.queue?.push({ type: 'steer-delivery' });
      log.info('devin-acp', 'steer-delivered', {
        requestId: request.requestId,
        method,
        insertion,
      });
      return { kind: 'accepted', runId: this.runId, insertion };
    } catch (error) {
      if (error instanceof DevinRpcError && error.code === -32601) {
        this.extensionSteeringRefused = true;
        log.warn('devin-acp', 'steer-extension-refused', {
          requestId: request.requestId,
          method,
        });
      }
      // Mirror the prompt-merge contract: a refused steer reports failure
      // both as the outcome and as a steer_delivery record.
      this.steerDeliveries.push({ requestId: request.requestId, insertion: 'failed' });
      this.queue?.push({ type: 'steer-delivery' });
      return steerErrorOutcome(error);
    }
  }

  private onSteerSettled(requestId: string, result: DevinPromptResult | Error): void {
    this.steerAttempts.delete(requestId);
    if (result instanceof Error) {
      log.warn('devin-acp', 'steer-failed', { requestId, message: result.message });
      this.steerDeliveries.push({ requestId, insertion: 'failed' });
      this.queue?.push({ type: 'steer-delivery' });
      return;
    }
    this.steerResults.set(requestId, result);
    this.classifySteerResults();
  }

  /**
   * Classify parked steer results once the turn's own userMessageId is known.
   * Same id means the prompt merged into the active turn; a different or
   * missing id means it became a turn of its own. Classified records land
   * in steerDeliveries and nudge the stream loop to emit them; the signal
   * is only a hint — events are taken from the array so none can be lost.
   */
  private classifySteerResults(): void {
    if (this.turnUserMessageId === undefined) return;
    for (const [requestId, result] of this.steerResults) {
      const insertion = extractUserMessageId(result) === this.turnUserMessageId
        ? 'into-active-turn'
        : 'as-new-turn';
      this.steerResults.delete(requestId);
      log.info('devin-acp', 'steer-delivered', { requestId, insertion });
      this.steerDeliveries.push({ requestId, insertion });
    }
    if (this.steerDeliveries.length > 0) this.queue?.push({ type: 'steer-delivery' });
  }

  private takeSteerDeliveries(): Array<{
    requestId: string;
    insertion: AgentSteeringInsertion | 'failed';
  }> {
    return this.steerDeliveries.splice(0);
  }

  /**
   * The run's event stream is ending — anything still unaccounted for gets a
   * terminal record so downstream delivery ledgers can close the request out.
   * Settled-but-unclassifiable results and attempts that never resolved are
   * recorded 'unconfirmed': the prompt was dispatched without refusal, so the
   * evidence says the engine owns it even though its landing is unknown.
   * Requeueing those would risk a duplicate.
   */
  private flushOrphanedSteers(): void {
    for (const requestId of this.steerResults.keys()) {
      log.info('devin-acp', 'steer-delivered', { requestId, insertion: 'unconfirmed' });
      this.steerDeliveries.push({ requestId, insertion: 'unconfirmed' });
    }
    this.steerResults.clear();
    for (const requestId of this.steerAttempts.keys()) {
      log.warn('devin-acp', 'steer-unsettled', { requestId });
      this.steerDeliveries.push({ requestId, insertion: 'unconfirmed' });
    }
    this.steerAttempts.clear();
  }

  private classifySteerResult(result: DevinPromptResult): AgentSteeringInsertion {
    if (this.turnUserMessageId === undefined) return 'unconfirmed';
    return extractUserMessageId(result) === this.turnUserMessageId
      ? 'into-active-turn'
      : 'as-new-turn';
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.turnClosing = true;
    if (this.client && this.sessionId && this.promptInFlight && !this.exited) {
      try {
        this.client.notify('session/cancel', { sessionId: this.sessionId });
      } catch {
        // The process may already be closing; the stream will report that outcome.
      }
    }
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;
    return Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  private async *stream(): AsyncGenerator<AgentEvent> {
    const queue = this.queue = new RunQueue();
    const messages = new DevinMessageTranslator();
    let offNotification: (() => void) | undefined;
    let offClosed: (() => void) | undefined;
    // session/load replays the whole conversation as session/update
    // notifications before resolving. Over stdio they always arrive while the
    // load request is in flight, so this flag marks them as replay — they are
    // history, not live turn events, and must not reach COT/progress rendering
    // (a replay burst overflows the message_cot update batch and fails the run's
    // progress bubble with field-validation errors).
    let loadingSession = false;
    const model = this.options.model && this.options.model !== 'default' ? this.options.model : undefined;
    try {
      this.client = await this.runtime.client();
      offNotification = this.client.onNotification((notification) => {
        queue.push({ type: 'notification', notification, replay: loadingSession });
      });
      offClosed = this.client.onClosed((error) => queue.push({ type: 'closed', error }));

      const cwd = this.options.cwd!;
      const sessionParams = {
        cwd,
        mcpServers: [],
      };
      const requestedSessionId = this.options.sessionId;
      loadingSession = Boolean(requestedSessionId);
      const session = await (async () => {
        try {
          return requestedSessionId
            ? await this.loadOrCreateSession(requestedSessionId, sessionParams)
            : await this.client!.request<DevinSessionResult>('session/new', sessionParams);
        } finally {
          loadingSession = false;
        }
      })();
      this.sessionId = extractSessionId(session, requestedSessionId);
      if (!this.sessionId) throw new Error('Devin ACP session response did not include sessionId');
      this.runtime.bindSession(this.sessionId, this);

      await this.applySessionMode(session);
      const resolvedModel = await this.applySessionModel(session, model);

      yield {
        type: 'system',
        sessionId: this.sessionId,
        cwd,
        ...(resolvedModel ? { model: resolvedModel } : {}),
      };

      const prompt = [
        {
          type: 'text',
          text: prefixBridgeSystemPrompt(this.options.prompt, this.options.identity),
        },
        ...await imageBlocks(this.options.images ?? []),
      ];
      this.promptInFlight = true;
      // No request deadline: a turn may legitimately run for hours. Its
      // lifecycle is governed by run policy on the event stream (silence
      // warnings, explicit stop → session/cancel), not by a transport
      // timeout. This promise settles on the turn-end response, an abort,
      // or the transport closing.
      void this.client.request<DevinPromptResult>('session/prompt', {
        sessionId: this.sessionId,
        prompt,
      }, 0).then(
        (result) => {
          // Capture the turn's message id before the signal reaches the
          // generator so steer results settling in the same tick classify
          // against it immediately.
          this.turnUserMessageId = extractUserMessageId(result);
          queue.push({ type: 'prompt-result', result });
        },
        (error) => queue.push({
          type: 'prompt-error',
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      );
      if (this.stopRequested) await this.stop();

      for await (const signal of queue) {
        if (signal.type === 'closed') {
          this.turnClosing = true;
          for (const event of messages.finish(false)) yield event;
          this.flushOrphanedSteers();
          for (const delivery of this.takeSteerDeliveries()) {
            yield { type: 'steer_delivery', ...delivery };
          }
          yield {
            type: 'error',
            message: signal.error.message,
            terminationReason: this.stopRequested ? 'interrupted' : 'failed',
          };
          return;
        }
        if (signal.type === 'prompt-error') {
          this.promptInFlight = false;
          this.turnClosing = true;
          for (const event of messages.finish(false)) yield event;
          this.flushOrphanedSteers();
          for (const delivery of this.takeSteerDeliveries()) {
            yield { type: 'steer_delivery', ...delivery };
          }
          yield {
            type: 'error',
            message: signal.error.message,
            terminationReason: this.stopRequested || isCancelled(signal.error)
              ? 'interrupted'
              : 'failed',
          };
          return;
        }
        if (signal.type === 'steer-delivery') {
          for (const delivery of this.takeSteerDeliveries()) {
            yield { type: 'steer_delivery', ...delivery };
          }
          continue;
        }
        if (signal.type === 'prompt-result') {
          this.promptInFlight = false;
          this.turnClosing = true;
          const cancelled = this.stopRequested || signal.result.stopReason === 'cancelled';
          for (const event of messages.finish(!cancelled)) yield event;
          const usage = extractDevinUsage(signal.result);
          if (usage) {
            yield { type: 'usage', ...usage };
          }
          if (this.steerAttempts.size > 0) {
            await Promise.race([
              Promise.allSettled([...this.steerAttempts.values()]),
              new Promise((resolve) => setTimeout(resolve, STEER_RESULT_SETTLE_MS)),
            ]);
          }
          this.classifySteerResults();
          this.flushOrphanedSteers();
          for (const delivery of this.takeSteerDeliveries()) {
            yield { type: 'steer_delivery', ...delivery };
          }
          yield {
            type: 'done',
            sessionId: this.sessionId,
            terminationReason: cancelled ? 'interrupted' : 'normal',
          };
          return;
        }

        const notification = signal.notification;
        if (signal.replay) continue;
        if (notification.method !== 'session/update') continue;
        const params = isRecord(notification.params)
          ? notification.params as DevinSessionUpdateParams
          : undefined;
        if (params?.sessionId && params.sessionId !== this.sessionId) continue;
        const update = isRecord(params?.update) ? params.update : undefined;
        if (!update) continue;
        const usage = update.sessionUpdate === 'usage_update' ? extractDevinUsage(update) : undefined;
        if (usage) {
          yield { type: 'usage', ...usage };
          continue;
        }
        for (const event of messages.handle(update)) yield event;
      }
    } catch (error) {
      this.turnClosing = true;
      for (const event of messages.finish(false)) yield event;
      this.flushOrphanedSteers();
      for (const delivery of this.takeSteerDeliveries()) {
        yield { type: 'steer_delivery', ...delivery };
      }
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        terminationReason: this.stopRequested ? 'interrupted' : 'failed',
      };
    } finally {
      this.promptInFlight = false;
      this.turnClosing = true;
      offNotification?.();
      offClosed?.();
      queue.end();
      this.exited = true;
      this.resolveExit();
      this.runtime.untrack(this);
    }
  }

  /**
   * Map Aria's access level onto the session's advertised ACP modes. When the
   * session does not advertise a matching mode the permission-request handler
   * still enforces the allow/reject ceiling.
   */
  private async applySessionMode(session: DevinSessionResult): Promise<void> {
    const desired = ACCESS_MODE_CANDIDATES[this.runtime.access];
    const advertised = (session.modes?.availableModes ?? [])
      .map((mode) => mode.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (advertised.length === 0) return;
    const current = session.modes?.currentModeId;
    const target = desired.find((id) => advertised.includes(id));
    if (!target || target === current) {
      if (!target) {
        log.warn('devin-acp', 'mode-unavailable', {
          requested: this.runtime.access,
          advertised,
        });
      }
      return;
    }
    try {
      await this.client!.request('session/set_mode', {
        sessionId: this.sessionId,
        modeId: target,
      }, 10_000);
    } catch (error) {
      log.warn('devin-acp', 'set-mode-failed', {
        modeId: target,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Devin has no dedicated `session/set_model`; per-session model selection
   * goes through `session/set_config_option` when the session advertises a
   * model option. Returns the model actually reported by the session.
   */
  private async applySessionModel(
    session: DevinSessionResult,
    requested: string | undefined,
  ): Promise<string | undefined> {
    const advertised = advertisedModel(session);
    const option = findConfigOption(session.configOptions, /model/i);
    if (!requested) return advertised;
    if (!option?.id) {
      log.warn('devin-acp', 'model-unsupported', { requested });
      return advertised ?? requested;
    }
    try {
      await this.client!.request('session/set_config_option', {
        sessionId: this.sessionId,
        configId: option.id,
        value: requested,
      }, 10_000);
      return requested;
    } catch (error) {
      if (error instanceof DevinRpcError && error.code === -32601) return advertised;
      log.warn('devin-acp', 'set-model-failed', {
        requested,
        message: error instanceof Error ? error.message : String(error),
      });
      return advertised ?? requested;
    }
  }

  private async loadOrCreateSession(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<DevinSessionResult> {
    try {
      return await this.client!.request<DevinSessionResult>('session/load', { sessionId, ...params });
    } catch (error) {
      if (!isMissingSessionError(error)) throw error;
      return this.client!.request<DevinSessionResult>('session/new', params);
    }
  }
}

function advertisedModel(session: DevinSessionResult): string | undefined {
  if (typeof session.models?.currentModelId === 'string') return session.models.currentModelId;
  const option = findConfigOption(session.configOptions, /model/i);
  return typeof option?.currentValue === 'string' ? option.currentValue : undefined;
}

/**
 * A steer prompt that fails within the dispatch grace window never reached
 * the engine — map the refusal so the coordinator can defer it to the next
 * turn instead of counting it delivered.
 */
function steerErrorOutcome(error: unknown): AgentSteeringOutcome {
  if (error instanceof DevinRpcError) {
    const reason = isRecord(error.data) && typeof error.data.reason === 'string'
      ? error.data.reason
      : undefined;
    if (error.code === -32602 || reason === 'no_running_turn') {
      return { kind: 'deferred', reason: 'turn-not-ready' };
    }
  }
  return {
    kind: 'rejected',
    reason: 'transport-error',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

/**
 * `_session/steering` reports `injected` / `startedNewTurn`; `session/inject`
 * in steer mode returns an agent-owned messageId with no status field. Any
 * explicit new-turn/queued status maps to as-new-turn; a bare success means
 * the engine took the input into the active turn.
 */
function classifyExtensionSteerResult(result: unknown): AgentSteeringInsertion {
  if (isRecord(result)) {
    const status = [result.status, result.outcome, result.insertion, result.kind]
      .find((value): value is string => typeof value === 'string');
    if (status) {
      const normalized = status.toLowerCase();
      if (normalized.includes('new') || normalized.includes('queue')) {
        return 'as-new-turn';
      }
      return 'into-active-turn';
    }
  }
  return 'into-active-turn';
}

function isCancelled(error: Error): boolean {
  return /cancel/i.test(error.message);
}

class RunQueue implements AsyncIterable<RunSignal> {
  private values: RunSignal[] = [];
  private waiters: Array<(value: IteratorResult<RunSignal>) => void> = [];
  private ended = false;

  push(value: RunSignal): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    this.values = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<RunSignal> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

async function imageBlocks(paths: readonly string[]): Promise<Array<{
  type: 'image';
  data: string;
  mimeType: string;
}>> {
  return Promise.all(paths.map(async (path) => ({
    type: 'image' as const,
    data: (await readFile(path)).toString('base64'),
    mimeType: mimeType(path),
  })));
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'image/png';
  }
}

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(path|session)\b.*\b(not found|missing)\b/i.test(message)
    || /no such file or directory/i.test(message);
}
