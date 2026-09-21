import {
  registerRuntimeQueries,
  type EngineAdoptedTurnInput,
  type EngineGoalSnapshot,
  type EngineTurnRef,
} from '../../../runtime/queries';
import { readCodexImportedHistory } from '../imported-history';
import { parseThreadListResponse } from '../../../../session/codex-history';
import type { SandboxMode } from '../../../../config/profile-schema';
import type { ModelOption } from '../../../models';
import { checkAgentAvailability, type AgentAvailability } from '../../../preflight';
import {
  defineEngineRuntimeDescriptor,
  type EngineRuntime,
  type EngineStatusSnapshot,
  type EngineUsageWindow,
} from '../../../runtime/types';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../types';
import type { AgentSteeringOutcome, AgentSteeringRequest } from '../../../steering';
import { prefixBridgeSystemPrompt } from '../../../bridge-system-prompt';
import type { ChannelEnvContext } from '../../../channel-env';
import { startCodexAppServer } from './process';
import type { CodexAppServerClient } from './client';
import { AppServerMessageTranslator } from './message-translator';
import { CodexGenerationMeter } from './generation-meter';
import {
  isRecord,
  type AccountRateLimitsResponse,
  type AccountResponse,
  type JsonRpcNotification,
  type ModelListResponse,
  type RateLimitSnapshot,
  type ThreadGoal,
  type ThreadGoalClearResponse,
  type ThreadGoalGetResponse,
  type ThreadGoalSetResponse,
  type ThreadResumeResponse,
  type ThreadStartResponse,
  type TokenUsageBreakdown,
  type TurnStartResponse,
  type TurnSteerResponse,
} from './protocol';

export interface CodexAppServerRuntimeOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome: boolean;
  sandbox: SandboxMode;
  ariaChannel?: ChannelEnvContext;
}

export class CodexAppServerRuntime implements EngineRuntime {
  readonly engineId = 'codex';
  readonly descriptor = defineEngineRuntimeDescriptor({
    engineId: this.engineId,
    topology: 'profile-daemon',
    capabilities: {
      inputs: ['text', 'image'],
      liveInput: { mode: 'direct', inputs: ['text'] },
      sessions: ['resume'],
      controls: ['interrupt', 'model', 'reasoning', 'service-tier', 'goal'],
      interactions: [],
      telemetry: ['usage', 'context', 'rate-limits'],
    },
  });
  readonly execution: AgentAdapter;

  private clientPromise: Promise<CodexAppServerClient> | undefined;
  private disposed = false;
  private latestModel: string | undefined;
  private latestContext: EngineStatusSnapshot['contextWindow'];
  private readonly activeRuns = new Set<AppServerRun>();
  private readonly claimedThreads = new Set<string>();
  private readonly engineTurnListeners = new Set<(turn: EngineTurnRef) => void>();
  private watchingEngineTurns = false;

  constructor(private readonly options: CodexAppServerRuntimeOptions) {
    this.execution = new CodexAppServerAdapter(this);
    registerRuntimeQueries(this, {
      listHistory: async ({ cwd, limit, signal }) => {
        const client = await this.client();
        const imports = await readCodexImportedHistory(this.options.profileStateDir, cwd);
        const cwds = [...new Set([cwd, ...imports.map(entry => entry.nativeCwd)])];
        const aliases = new Map(imports.map(entry => [entry.nativeId, entry.nativeCwd]));
        const entries = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        for (let page = 0; page < 100; page++) {
          const response = await client.request<{ nextCursor?: string | null }>('thread/list', {
            cwd: cwds.length === 1 ? cwd : cwds, limit: imports.length ? 100 : limit,
            sortKey: 'updated_at', sortDirection: 'desc', archived: false, ...(cursor ? { cursor } : {}),
            ...(imports.length ? { modelProviders: [] } : {}),
            useStateDbOnly: true, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
          }, 5000, signal);
          const parsed = parseThreadListResponse(response);
          if (!parsed.ok) throw parsed.error;
          entries.push(...parsed.entries.filter(entry => entry.cwd === cwd || aliases.get(entry.threadId) === entry.cwd));
          cursor = response.nextCursor ?? undefined;
          if (entries.length >= limit || !cursor || !imports.length) break;
          if (cursors.has(cursor)) throw new Error('native history cursor repeated');
          cursors.add(cursor);
        }
        return entries.slice(0, limit).map((entry) => ({ id: entry.threadId, preview: entry.name || entry.preview,
          updatedAtMs: entry.updatedAtMs, detail: 'Codex' }));
      },
      goal: {
        get: async (threadId) => {
          const client = await this.client();
          const response = await client.request<ThreadGoalGetResponse>('thread/goal/get', { threadId });
          return response.goal ? goalSnapshot(response.goal) : null;
        },
        set: async (threadId, input) => {
          const client = await this.client();
          const response = await client.request<ThreadGoalSetResponse>('thread/goal/set', {
            threadId,
            ...(input.objective === undefined ? {} : { objective: input.objective }),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
          });
          return goalSnapshot(response.goal);
        },
        clear: async (threadId) => {
          const client = await this.client();
          await client.request<ThreadGoalClearResponse>('thread/goal/clear', { threadId });
        },
      },
      engineTurns: {
        subscribe: (listener) => this.onEngineTurn(listener),
      },
      adoptedTurn: async (input) => {
        const run = AppServerRun.adopted(this, input);
        this.track(run);
        try {
          await run.attach();
        } catch (error) {
          this.untrack(run);
          throw error;
        }
        return run;
      },
    });
  }

  async client(): Promise<CodexAppServerClient> {
    if (this.disposed) throw new Error('codex app-server runtime is disposed');
    if (!this.clientPromise) {
      const started = startCodexAppServer({
        binary: this.options.binary,
        cwd: this.options.profileStateDir,
        profileStateDir: this.options.profileStateDir,
        ...(this.options.codexHome ? { codexHome: this.options.codexHome } : {}),
        inheritCodexHome: this.options.inheritCodexHome,
        ...(this.options.ariaChannel ? { ariaChannel: this.options.ariaChannel } : {}),
      });
      this.clientPromise = started;
      void started.then(
        (client) => {
          this.watchEngineTurns(client);
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

  track(run: AppServerRun): void {
    this.activeRuns.add(run);
  }

  /**
   * Threads a caller asked the engine to work on. An engine-started turn on a
   * thread nobody claimed is a goal continuation, and is announced rather than
   * ignored.
   */
  claimThread(threadId: string): void {
    this.claimedThreads.add(threadId);
  }

  releaseThread(threadId: string): void {
    this.claimedThreads.delete(threadId);
  }

  onEngineTurn(listener: (turn: EngineTurnRef) => void): () => void {
    this.engineTurnListeners.add(listener);
    return () => this.engineTurnListeners.delete(listener);
  }

  private watchEngineTurns(client: CodexAppServerClient): void {
    if (this.watchingEngineTurns) return;
    this.watchingEngineTurns = true;
    client.onNotification((notification) => {
      if (notification.method !== 'turn/started') return;
      const params = isRecord(notification.params) ? notification.params : {};
      const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
      const turn = isRecord(params.turn) ? params.turn : undefined;
      const turnId = turn && typeof turn.id === 'string' ? turn.id : undefined;
      if (!threadId || !turnId || this.claimedThreads.has(threadId)) return;
      for (const listener of this.engineTurnListeners) listener({ threadId, turnId });
    });
  }

  untrack(run: AppServerRun): void {
    this.activeRuns.delete(run);
  }

  setLatestUsage(model: string | undefined, usage: TokenUsageBreakdown, totalTokens?: number): void {
    if (model) this.latestModel = model;
    this.latestContext = {
      usedTokens: usage.totalTokens,
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    };
  }

  async statusSnapshot(): Promise<EngineStatusSnapshot> {
    const client = await this.client();
    const [account, models] = await Promise.all([
      client.request<AccountResponse>('account/read'),
      this.listModelResponses(),
    ]);
    // `account/rateLimits/read` requires ChatGPT login; apiKey/bedrock accounts
    // always fail the probe, so it is only sent when the account qualifies.
    const limits = account.account?.type === 'chatgpt'
      ? await client.request<AccountRateLimitsResponse>('account/rateLimits/read')
      : undefined;
    const defaultModel = models.find((model) => model.isDefault);
    return {
      model: this.latestModel ?? defaultModel?.displayName ?? defaultModel?.model,
      ...accountStatus(account),
      ...(this.latestContext ? { contextWindow: this.latestContext } : {}),
      ...(limits ? { rateLimits: rateLimitWindows(limits) } : {}),
      updatedAt: Date.now(),
    };
  }

  async listModels(signal: AbortSignal): Promise<ModelOption[]> {
    const models = await this.listModelResponses(signal);
    return models.map((model) => ({
      value: model.model,
      label: model.displayName || model.model,
      isDefault: model.isDefault,
      ...(model.supportedReasoningEfforts?.length
        ? {
            reasoning: {
              options: model.supportedReasoningEfforts.map((option) => ({
                value: option.reasoningEffort,
                label: option.reasoningEffort,
                description: option.description,
                ...(option.reasoningEffort === 'ultra'
                  ? { semantics: 'multi-agent' as const }
                  : {}),
              })),
              ...(model.defaultReasoningEffort
                ? { defaultValue: model.defaultReasoningEffort }
                : {}),
            },
          }
        : {}),
      ...(model.serviceTiers?.length
        ? {
            serviceTiers: {
              options: model.serviceTiers.map((tier) => ({
                value: tier.id,
                label: tier.name || tier.id,
                ...(tier.description ? { description: tier.description } : {}),
              })),
              ...(model.defaultServiceTier
                ? { defaultValue: model.defaultServiceTier }
                : {}),
            },
          }
        : {}),
    }));
  }

  private async listModelResponses(signal?: AbortSignal): Promise<ModelListResponse['data']> {
    const client = await this.client();
    const models: ModelListResponse['data'] = [];
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await client.request<ModelListResponse>(
        'model/list',
        { limit: 100, ...(cursor ? { cursor } : {}) },
        7_500,
        signal,
      );
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return models;
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
  }

  availability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex App Server',
      command: this.options.binary,
      binaryPath: this.options.binary,
    });
  }

  get sandbox(): SandboxMode {
    return this.options.sandbox;
  }
}

class CodexAppServerAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex App Server';

  constructor(private readonly runtime: CodexAppServerRuntime) {}

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
    if (!options.cwd) throw new Error('cwd is required for Codex App Server');
    const run = new AppServerRun(this.runtime, options);
    this.runtime.track(run);
    return run;
  }
}

export class AppServerRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly steering = { mode: 'direct' as const, textOnly: true, mechanism: 'native' as const, delivery: 'confirmed' as const };
  private threadId: string | undefined;
  private turnId: string | undefined;
  private client: CodexAppServerClient | undefined;
  private queue: NotificationQueue | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopRequested = false;
  private interruptSent = false;
  private turnClosing = false;
  private exited = false;
  private readonly steeringRequests = new Map<string, Promise<AgentSteeringOutcome>>();
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(
    private readonly runtime: CodexAppServerRuntime,
    private readonly options: AgentRunOptions,
    private readonly adopted?: EngineAdoptedTurnInput,
  ) {
    this.runId = options.runId;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.events = this.stream();
  }

  /**
   * A run for a turn this process never asked for. The engine already has a
   * prompt, so this attaches before it can miss anything the turn emits.
   */
  static adopted(runtime: CodexAppServerRuntime, input: EngineAdoptedTurnInput): AppServerRun {
    const run = new AppServerRun(runtime, {
      runId: `engine-turn:${input.turnId}`,
      scopeId: input.threadId,
      prompt: '',
      cwd: input.cwd,
      threadId: input.threadId,
    }, input);
    run.threadId = input.threadId;
    run.turnId = input.turnId;
    return run;
  }

  /** Subscribe now, so the stream starts from the turn's first notification. */
  async attach(): Promise<void> {
    this.client = await this.runtime.client();
    this.queue = new NotificationQueue();
    this.unsubscribe = this.client.onNotification((notification) => this.queue!.push(notification));
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.turnClosing = true;
    if (this.client && this.threadId && this.turnId && !this.exited && !this.interruptSent) {
      this.interruptSent = true;
      await this.client
        .request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 5_000)
        .catch(() => undefined);
    }
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;
    return Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  steer(request: AgentSteeringRequest): Promise<AgentSteeringOutcome> {
    const existing = this.steeringRequests.get(request.requestId);
    if (existing) return existing;
    const attempt = this.performSteer(request);
    this.steeringRequests.set(request.requestId, attempt);
    return attempt;
  }

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
    const client = this.client;
    const threadId = this.threadId;
    const turnId = this.turnId;
    if (!client || !threadId || !turnId) {
      return { kind: 'deferred', reason: 'turn-not-ready' };
    }

    try {
      const response = await client.request<TurnSteerResponse>('turn/steer', {
        threadId,
        input: [{ type: 'text', text: request.prompt, text_elements: [] }],
        expectedTurnId: turnId,
      }, 5_000);
      if (response.turnId !== turnId) {
        return { kind: 'rejected', reason: 'stale-run' };
      }
      return { kind: 'accepted', runId: this.runId };
    } catch (error) {
      return {
        kind: 'rejected',
        reason: 'transport-error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async *stream(): AsyncGenerator<AgentEvent> {
    const messages = new AppServerMessageTranslator();
    const generation = new CodexGenerationMeter();
    let latestUsage: TokenUsageBreakdown | undefined;
    let latestContextUsage: TokenUsageBreakdown | undefined;
    let latestContextWindow: number | undefined;
    let model: string | undefined;

    try {
      if (this.adopted) {
        // `attach()` already subscribed and fixed the thread and turn ids.
        this.runtime.claimThread(this.adopted.threadId);
        yield { type: 'system', threadId: this.adopted.threadId, cwd: this.options.cwd };
      } else {
      this.client = await this.runtime.client();
      this.queue = new NotificationQueue();
      this.unsubscribe = this.client.onNotification((notification) => this.queue!.push(notification));
      const thread = this.options.threadId
        ? await this.client.request<ThreadResumeResponse>('thread/resume', {
            threadId: this.options.threadId,
            cwd: this.options.cwd,
            approvalPolicy: 'never',
            sandbox: this.options.sandbox ?? this.runtime.sandbox,
            ...(this.options.model ? { model: this.options.model } : {}),
            ...(this.options.serviceTier !== undefined
              ? { serviceTier: this.options.serviceTier }
              : {}),
          })
        : await this.client.request<ThreadStartResponse>('thread/start', {
            cwd: this.options.cwd,
            approvalPolicy: 'never',
            sandbox: this.options.sandbox ?? this.runtime.sandbox,
            ...(this.options.model ? { model: this.options.model } : {}),
            ...(this.options.serviceTier !== undefined
              ? { serviceTier: this.options.serviceTier }
              : {}),
          });
      this.threadId = thread.thread.id;
      model = thread.model;
      const threadReasoningEffort = typeof thread.reasoningEffort === 'string'
        ? thread.reasoningEffort.trim()
        : '';
      const requestedReasoningEffort = this.options.reasoningEffort?.trim();
      const reasoningEffort = requestedReasoningEffort && requestedReasoningEffort !== 'default'
        ? requestedReasoningEffort
        : threadReasoningEffort;
      yield {
        type: 'system',
        threadId: this.threadId,
        cwd: this.options.cwd,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...('serviceTier' in thread ? { serviceTier: thread.serviceTier ?? null } : {}),
      };

      const input: unknown[] = [
        {
          type: 'text',
          text: prefixBridgeSystemPrompt(this.options.prompt, this.options.identity),
          text_elements: [],
        },
        ...(this.options.images ?? []).map((path) => ({
          type: 'localImage',
          path,
        })),
      ];
      // Claim before the request: `turn/started` can beat its own response.
      this.runtime.claimThread(this.threadId);
      const started = await this.client.request<TurnStartResponse>('turn/start', {
        threadId: this.threadId,
        input,
        cwd: this.options.cwd,
        approvalPolicy: 'never',
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.reasoningEffort && this.options.reasoningEffort !== 'default'
          ? { effort: this.options.reasoningEffort }
          : {}),
        ...(this.options.serviceTier !== undefined
          ? { serviceTier: this.options.serviceTier }
          : {}),
      });
      this.turnId = started.turn.id;
      if (this.stopRequested) await this.stop();
      }

      const queue = this.queue!;
      for await (const notification of queue) {
        const params = isRecord(notification.params) ? notification.params : {};
        if (notification.method === 'aria/appServerClosed') {
          for (const event of messages.boundary()) yield event;
          yield {
            type: 'error',
            message: typeof params.message === 'string' ? params.message : 'codex app-server closed',
            terminationReason: this.stopRequested ? 'interrupted' : 'failed',
          };
          return;
        }
        if (params.threadId !== this.threadId) continue;
        if (typeof params.turnId === 'string' && params.turnId !== this.turnId) continue;

        if (notification.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          if (params.delta.length > 0) generation.observeToken(performance.now());
          const itemId = typeof params.itemId === 'string' ? params.itemId : 'agent-message';
          for (const event of messages.append(itemId, params.delta)) yield event;
        } else if (
          (notification.method === 'item/reasoning/summaryTextDelta' ||
            notification.method === 'item/reasoning/textDelta') &&
          typeof params.delta === 'string'
        ) {
          if (params.delta.length > 0) generation.observeToken(performance.now());
          for (const event of messages.boundary()) yield event;
          yield { type: 'thinking', delta: params.delta };
        } else if (notification.method === 'item/started') {
          const event = toolUseEvent(params.item);
          if (event) generation.closeStep(performance.now());
          for (const progress of messages.boundary()) yield progress;
          if (event) yield event;
        } else if (notification.method === 'item/completed') {
          const message = agentMessageItem(params.item);
          if (message) {
            generation.closeStep(performance.now());
            for (const progress of messages.complete(message.id, message.text)) yield progress;
            continue;
          }
          const event = toolResultEvent(params.item);
          if (event) yield event;
        } else if (notification.method === 'thread/tokenUsage/updated') {
          const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined;
          const totalValue = tokenUsage?.total;
          const lastValue = tokenUsage?.last;
          const total = isTokenUsage(totalValue) ? totalValue : undefined;
          const last = isTokenUsage(lastValue) ? lastValue : undefined;
          if (total) {
            latestUsage = total;
            if (last) latestContextUsage = last;
            const contextWindow =
              typeof tokenUsage?.modelContextWindow === 'number' ? tokenUsage.modelContextWindow : undefined;
            latestContextWindow = contextWindow;
            this.runtime.setLatestUsage(model, last ?? total, contextWindow);
            if (last) {
              const measured = generation.observeUsage(total, last, performance.now());
              if (measured) yield { type: 'performance', generation: measured };
            }
          }
        } else if (notification.method === 'error') {
          const error = isRecord(params.error) ? params.error : undefined;
          if (params.willRetry !== true) {
            for (const event of messages.boundary()) yield event;
            yield {
              type: 'error',
              message: typeof error?.message === 'string' ? error.message : 'codex app-server turn failed',
              terminationReason: 'failed',
            };
            return;
          }
        } else if (notification.method === 'turn/completed') {
          this.turnClosing = true;
          const turn = isRecord(params.turn) ? params.turn : undefined;
          generation.closeStep(performance.now());
          for (const event of messages.finishTurn(turn?.status === 'completed')) yield event;
          if (latestUsage) {
            yield {
              type: 'usage',
              inputTokens: latestUsage.inputTokens,
              outputTokens: latestUsage.outputTokens,
              cachedInputTokens: latestUsage.cachedInputTokens,
              reasoningOutputTokens: latestUsage.reasoningOutputTokens,
              contextUsedTokens: (latestContextUsage ?? latestUsage).totalTokens,
              ...(latestContextWindow !== undefined
                ? { contextWindowTokens: latestContextWindow }
                : {}),
            };
          }
          if (turn?.status === 'failed') {
            const error = isRecord(turn.error) ? turn.error : undefined;
            yield {
              type: 'error',
              message: typeof error?.message === 'string' ? error.message : 'codex app-server turn failed',
              terminationReason: 'failed',
            };
          } else {
            yield {
              type: 'done',
              threadId: this.threadId,
              terminationReason: turn?.status === 'interrupted' ? 'interrupted' : 'normal',
            };
          }
          return;
        }
      }
      for (const event of messages.boundary()) yield event;
      yield {
        type: 'error',
        message: 'codex app-server notification stream ended unexpectedly',
        terminationReason: 'failed',
      };
    } catch (error) {
      for (const event of messages.boundary()) yield event;
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        terminationReason: this.stopRequested ? 'interrupted' : 'failed',
      };
    } finally {
      this.turnClosing = true;
      this.unsubscribe?.();
      this.queue?.end();
      if (this.threadId) this.runtime.releaseThread(this.threadId);
      this.exited = true;
      this.resolveExit();
      this.runtime.untrack(this);
    }
  }
}

function agentMessageItem(value: unknown): { id: string; text?: string } | undefined {
  if (!isRecord(value) || value.type !== 'agentMessage' || typeof value.id !== 'string') return;
  const text = typeof value.text === 'string'
    ? value.text
    : typeof value.message === 'string'
      ? value.message
      : undefined;
  return { id: value.id, ...(text !== undefined ? { text } : {}) };
}

class NotificationQueue implements AsyncIterable<JsonRpcNotification> {
  private values: JsonRpcNotification[] = [];
  private waiters: Array<(value: IteratorResult<JsonRpcNotification>) => void> = [];
  private ended = false;

  push(value: JsonRpcNotification): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<JsonRpcNotification> {
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

function toolUseEvent(itemValue: unknown): AgentEvent | undefined {
  if (!isRecord(itemValue) || typeof itemValue.id !== 'string' || typeof itemValue.type !== 'string') return;
  switch (itemValue.type) {
    case 'commandExecution':
      return {
        type: 'tool_use',
        id: itemValue.id,
        name: 'command_execution',
        input: { command: itemValue.command },
      };
    case 'fileChange':
      return {
        type: 'tool_use',
        id: itemValue.id,
        name: 'file_change',
        input: itemValue.changes,
      };
    case 'mcpToolCall':
      return {
        type: 'tool_use',
        id: itemValue.id,
        name: `${itemValue.server}.${itemValue.tool}`,
        input: itemValue.arguments,
      };
    case 'dynamicToolCall':
      return {
        type: 'tool_use',
        id: itemValue.id,
        name: String(itemValue.tool),
        input: itemValue.arguments,
      };
    default:
      return;
  }
}

function toolResultEvent(itemValue: unknown): AgentEvent | undefined {
  if (!isRecord(itemValue) || typeof itemValue.id !== 'string' || typeof itemValue.type !== 'string') return;
  if (itemValue.type === 'commandExecution') {
    return {
      type: 'tool_result',
      id: itemValue.id,
      output: typeof itemValue.aggregatedOutput === 'string' ? itemValue.aggregatedOutput : '',
      isError: typeof itemValue.exitCode === 'number' && itemValue.exitCode !== 0,
    };
  }
  if (itemValue.type === 'fileChange') {
    return {
      type: 'tool_result',
      id: itemValue.id,
      output: String(itemValue.status ?? ''),
      isError: itemValue.status === 'failed',
    };
  }
  if (itemValue.type === 'mcpToolCall' || itemValue.type === 'dynamicToolCall') {
    return {
      type: 'tool_result',
      id: itemValue.id,
      output: JSON.stringify(itemValue.result ?? itemValue.contentItems ?? itemValue.error ?? ''),
      isError: Boolean(itemValue.error) || itemValue.success === false,
    };
  }
}

function isTokenUsage(value: unknown): value is TokenUsageBreakdown {
  return (
    isRecord(value) &&
    typeof value.totalTokens === 'number' &&
    typeof value.inputTokens === 'number' &&
    typeof value.cachedInputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.reasoningOutputTokens === 'number'
  );
}

function accountStatus(response: AccountResponse): Pick<EngineStatusSnapshot, 'account' | 'plan'> {
  if (!response.account) return {};
  if (response.account.type === 'chatgpt') {
    return {
      ...(response.account.email ? { account: response.account.email } : {}),
      plan: response.account.planType,
    };
  }
  return {
    account: response.account.type === 'apiKey' ? 'API key' : 'Amazon Bedrock',
  };
}

function rateLimitWindows(response: AccountRateLimitsResponse): EngineUsageWindow[] {
  const snapshots = response.rateLimitsByLimitId ? Object.values(response.rateLimitsByLimitId) : [response.rateLimits];
  const result: EngineUsageWindow[] = [];
  for (const snapshot of snapshots) appendRateLimitWindows(result, snapshot);
  return result;
}

function appendRateLimitWindows(result: EngineUsageWindow[], snapshot: RateLimitSnapshot): void {
  const name = snapshot.limitName ?? snapshot.limitId ?? 'Codex';
  for (const [kind, window] of [
    ['primary', snapshot.primary],
    ['secondary', snapshot.secondary],
  ] as const) {
    if (!window) continue;
    result.push({
      label: `${name} ${kind}`,
      usedPercent: window.usedPercent,
      ...(window.windowDurationMins !== null ? { windowDurationMins: window.windowDurationMins } : {}),
      ...(window.resetsAt !== null ? { resetsAt: window.resetsAt } : {}),
    });
  }
}

/** Drop the App Server's thread id: callers already hold the thread they asked about. */
function goalSnapshot(goal: ThreadGoal): EngineGoalSnapshot {
  return {
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}
