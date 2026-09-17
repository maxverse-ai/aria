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
  findConfigOption,
  isRecord,
  type DevinJsonRpcNotification,
  type DevinJsonRpcRequest,
  type DevinPromptResult,
  type DevinSessionResult,
  type DevinSessionUpdateParams,
} from './protocol';
import { resolveDevinApiKey, startDevinAcp } from './process';

export interface DevinAcpRuntimeOptions {
  binary: string;
  profileStateDir: string;
  access: AccessMode;
  model?: string;
  apiKeyEnv?: string;
  ariaChannel?: ChannelEnvContext;
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
      liveInput: { mode: 'none', inputs: [] },
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
  | { type: 'closed'; error: Error };

export class DevinAgentRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  private sessionId: string | undefined;
  private client: DevinAcpClient | undefined;
  private promptInFlight = false;
  private stopRequested = false;
  private exited = false;
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

  async stop(): Promise<void> {
    this.stopRequested = true;
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
    const queue = new RunQueue();
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
      void this.client.request<DevinPromptResult>('session/prompt', {
        sessionId: this.sessionId,
        prompt,
      }, 30 * 60_000).then(
        (result) => queue.push({ type: 'prompt-result', result }),
        (error) => queue.push({
          type: 'prompt-error',
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      );
      if (this.stopRequested) await this.stop();

      for await (const signal of queue) {
        if (signal.type === 'closed') {
          for (const event of messages.finish(false)) yield event;
          yield {
            type: 'error',
            message: signal.error.message,
            terminationReason: this.stopRequested ? 'interrupted' : 'failed',
          };
          return;
        }
        if (signal.type === 'prompt-error') {
          this.promptInFlight = false;
          for (const event of messages.finish(false)) yield event;
          yield {
            type: 'error',
            message: signal.error.message,
            terminationReason: this.stopRequested || isCancelled(signal.error)
              ? 'interrupted'
              : 'failed',
          };
          return;
        }
        if (signal.type === 'prompt-result') {
          this.promptInFlight = false;
          const cancelled = this.stopRequested || signal.result.stopReason === 'cancelled';
          for (const event of messages.finish(!cancelled)) yield event;
          const usage = extractDevinUsage(signal.result);
          if (usage) {
            yield { type: 'usage', ...usage };
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
      for (const event of messages.finish(false)) yield event;
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        terminationReason: this.stopRequested ? 'interrupted' : 'failed',
      };
    } finally {
      this.promptInFlight = false;
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
