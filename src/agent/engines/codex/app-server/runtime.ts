import type { SandboxMode } from '../../../../config/profile-schema';
import type { ModelOption } from '../../../models';
import { checkAgentAvailability, type AgentAvailability } from '../../../preflight';
import type { EngineRuntime, EngineStatusSnapshot, EngineUsageWindow } from '../../../runtime/types';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../../../types';
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
  type ThreadResumeResponse,
  type ThreadStartResponse,
  type TokenUsageBreakdown,
  type TurnStartResponse,
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
  readonly execution: AgentAdapter;

  private clientPromise: Promise<CodexAppServerClient> | undefined;
  private disposed = false;
  private latestModel: string | undefined;
  private latestContext: EngineStatusSnapshot['contextWindow'];
  private readonly activeRuns = new Set<AppServerRun>();

  constructor(private readonly options: CodexAppServerRuntimeOptions) {
    this.execution = new CodexAppServerAdapter(this);
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
    const [account, limits, models] = await Promise.all([
      client.request<AccountResponse>('account/read'),
      client.request<AccountRateLimitsResponse>('account/rateLimits/read'),
      this.listModelResponses(),
    ]);
    const defaultModel = models.find((model) => model.isDefault);
    return {
      model: this.latestModel ?? defaultModel?.displayName ?? defaultModel?.model,
      ...accountStatus(account),
      ...(this.latestContext ? { contextWindow: this.latestContext } : {}),
      rateLimits: rateLimitWindows(limits),
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
  private botIdentity: AgentBotIdentity | undefined;

  constructor(private readonly runtime: CodexAppServerRuntime) {}

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

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
    const run = new AppServerRun(this.runtime, options, this.botIdentity);
    this.runtime.track(run);
    return run;
  }
}

export class AppServerRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private client: CodexAppServerClient | undefined;
  private stopRequested = false;
  private interruptSent = false;
  private exited = false;
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(
    private readonly runtime: CodexAppServerRuntime,
    private readonly options: AgentRunOptions,
    private readonly botIdentity: AgentBotIdentity | undefined,
  ) {
    this.runId = options.runId;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.events = this.stream();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
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

  private async *stream(): AsyncGenerator<AgentEvent> {
    const queue = new NotificationQueue();
    let unsubscribe: (() => void) | undefined;
    const messages = new AppServerMessageTranslator();
    const generation = new CodexGenerationMeter();
    let latestUsage: TokenUsageBreakdown | undefined;
    let latestContextUsage: TokenUsageBreakdown | undefined;
    let latestContextWindow: number | undefined;
    let model: string | undefined;

    try {
      this.client = await this.runtime.client();
      unsubscribe = this.client.onNotification((notification) => queue.push(notification));
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
          text: prefixBridgeSystemPrompt(this.options.prompt, this.botIdentity),
          text_elements: [],
        },
        ...(this.options.images ?? []).map((path) => ({
          type: 'localImage',
          path,
        })),
      ];
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
      unsubscribe?.();
      queue.end();
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
