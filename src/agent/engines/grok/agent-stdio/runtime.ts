import { assertRunAuthorization } from '../../../runtime/run-authorization';
import { registerRuntimeQueries } from '../../../runtime/queries';
import { listGrokSessionsWithClient } from '../history';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AccessMode } from '../../../../config/permissions';
import { checkAgentAvailability, type AgentAvailability } from '../../../preflight';
import {
  defineEngineRuntimeDescriptor,
  type EngineRuntime,
  type EngineStatusSnapshot,
} from '../../../runtime/types';
import type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../../types';
import type { AgentSteeringOutcome, AgentSteeringRequest } from '../../../steering';
import { prefixBridgeSystemPrompt } from '../../../bridge-system-prompt';
import type { ModelOption } from '../../../models';
import type { ChannelEnvContext } from '../../../channel-env';
import {
  GrokRpcError,
  GrokServerRequestError,
  type GrokAgentStdioClient,
} from './client';
import { GrokMessageTranslator } from './message-translator';
import {
  extractGrokUsage,
  extractSessionId,
  isRecord,
  type GrokJsonRpcNotification,
  type GrokJsonRpcRequest,
  type GrokModelState,
  type GrokPromptResult,
  type GrokSessionResult,
  type GrokSessionUpdateParams,
} from './protocol';
import { startGrokAgentStdio } from './process';

export interface GrokAgentStdioRuntimeOptions {
  binary: string;
  profileStateDir: string;
  grokHome?: string;
  inheritGrokHome: boolean;
  access: AccessMode;
  ariaChannel?: ChannelEnvContext;
}

export class GrokAgentStdioRuntime implements EngineRuntime {
  readonly engineId = 'grok';
  readonly descriptor = defineEngineRuntimeDescriptor({
    engineId: this.engineId,
    topology: 'profile-daemon',
    capabilities: {
      inputs: ['text', 'image'],
      liveInput: { mode: 'direct', inputs: ['text'] },
      sessions: ['resume', 'list'],
      controls: ['interrupt', 'model', 'reasoning'],
      interactions: [],
      telemetry: ['usage'],
    },
  });
  readonly execution: AgentAdapter;

  private clientPromise: Promise<GrokAgentStdioClient> | undefined;
  private disposed = false;
  private latestModel: string | undefined;
  private readonly activeRuns = new Set<GrokAgentRun>();
  private readonly activeSessions = new Map<string, GrokAgentRun>();

  constructor(private readonly options: GrokAgentStdioRuntimeOptions) {
    this.execution = new GrokAgentStdioAdapter(this);
    registerRuntimeQueries(this, {
      listHistory: async (input) => listGrokSessionsWithClient(await this.client(), input),
    });
  }

  async client(): Promise<GrokAgentStdioClient> {
    if (this.disposed) throw new Error('grok agent stdio runtime is disposed');
    if (!this.clientPromise) {
      const started = startGrokAgentStdio({
        binary: this.options.binary,
        cwd: this.options.profileStateDir,
        profileStateDir: this.options.profileStateDir,
        ...(this.options.grokHome ? { grokHome: this.options.grokHome } : {}),
        inheritGrokHome: this.options.inheritGrokHome,
        access: this.options.access,
        ...(this.options.ariaChannel ? { ariaChannel: this.options.ariaChannel } : {}),
        handleServerRequest: (request) => this.handleServerRequest(request),
      });
      this.clientPromise = started;
      void started.then(
        (client) => {
          this.latestModel = modelState(client.modelState)?.currentModelId;
          client.onNotification((notification) => {
            if (notification.method !== '_x.ai/models/update') return;
            const params = isRecord(notification.params) ? notification.params : undefined;
            if (typeof params?.currentModelId === 'string') this.latestModel = params.currentModelId;
          });
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

  track(run: GrokAgentRun): void {
    this.activeRuns.add(run);
  }

  untrack(run: GrokAgentRun): void {
    this.activeRuns.delete(run);
    if (run.currentSessionId && this.activeSessions.get(run.currentSessionId) === run) {
      this.activeSessions.delete(run.currentSessionId);
    }
  }

  bindSession(sessionId: string, run: GrokAgentRun): void {
    const existing = this.activeSessions.get(sessionId);
    if (existing && existing !== run) throw new Error('Grok session is already owned by another active run');
    this.activeSessions.set(sessionId, run);
  }

  setLatestModel(model: string | undefined): void {
    if (model) this.latestModel = model;
  }

  async statusSnapshot(): Promise<EngineStatusSnapshot> {
    await this.client();
    return {
      ...(this.latestModel ? { model: this.latestModel } : {}),
      updatedAt: Date.now(),
    };
  }

  async listModels(signal: AbortSignal): Promise<ModelOption[]> {
    if (signal.aborted) throw abortError(signal);
    const client = await this.client();
    if (signal.aborted) throw abortError(signal);
    const state = modelState(client.modelState);
    return (state?.availableModels ?? []).flatMap((model) => {
      if (!model.modelId) return [];
      const efforts = reasoningEfforts(model._meta);
      return [{
        value: model.modelId,
        label: model.name || model.modelId,
        isDefault: state?.currentModelId === model.modelId,
        ...(efforts.options.length > 0 ? { reasoning: efforts } : {}),
      } satisfies ModelOption];
    });
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
      agentId: 'grok',
      agentName: 'Grok Build',
      command: this.options.binary,
      binaryPath: this.options.binary,
    });
  }

  get fullAccess(): boolean {
    return this.options.access === 'full';
  }

  private async handleServerRequest(request: GrokJsonRpcRequest): Promise<unknown> {
    if (request.method !== 'session/request_permission') {
      throw new GrokServerRequestError(`unsupported Grok ACP server request: ${request.method}`);
    }
    const params = isRecord(request.params) ? request.params : undefined;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined;
    if (!sessionId || !this.activeSessions.has(sessionId)) {
      throw new GrokServerRequestError('Grok permission request does not match an active session', -32602);
    }
    const desiredKind = this.activeSessions.get(sessionId)!.allowsPermission() ? 'allow_once' : 'reject_once';
    const option = Array.isArray(params?.options)
      ? params.options.find((candidate) => isRecord(candidate) && candidate.kind === desiredKind)
      : undefined;
    if (!isRecord(option) || typeof option.optionId !== 'string') {
      throw new GrokServerRequestError(
        `Grok permission request does not offer ${desiredKind}`,
        -32602,
      );
    }
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }
}

class GrokAgentStdioAdapter implements AgentAdapter {
  readonly id = 'grok';
  readonly displayName = 'Grok Build';

  constructor(private readonly runtime: GrokAgentStdioRuntime) {}

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
    if (!options.cwd) throw new Error('cwd is required for Grok Build');
    const run = new GrokAgentRun(this.runtime, options);
    this.runtime.track(run);
    return run;
  }
}

type RunSignal =
  | { type: 'notification'; notification: GrokJsonRpcNotification }
  | { type: 'prompt-result'; result: GrokPromptResult }
  | { type: 'prompt-error'; error: Error }
  | { type: 'closed'; error: Error };

export class GrokAgentRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly steering = { mode: 'direct' as const, textOnly: true };
  private sessionId: string | undefined;
  private client: GrokAgentStdioClient | undefined;
  private promptInFlight = false;
  private stopRequested = false;
  private turnClosing = false;
  private exited = false;
  private readonly steeringRequests = new Map<string, Promise<AgentSteeringOutcome>>();
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  allowsPermission(): boolean {
    assertRunAuthorization(this.options);
    return this.runtime.fullAccess && (this.options.sandbox === undefined || this.options.sandbox === 'danger-full-access');
  }

  constructor(
    private readonly runtime: GrokAgentStdioRuntime,
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

  steer(request: AgentSteeringRequest): Promise<AgentSteeringOutcome> {
    const existing = this.steeringRequests.get(request.requestId);
    if (existing) return existing;
    const attempt = this.performSteer(request);
    this.steeringRequests.set(request.requestId, attempt);
    return attempt;
  }

  private async performSteer(request: AgentSteeringRequest): Promise<AgentSteeringOutcome> {
    if (request.expectedRunId !== this.runId) return { kind: 'rejected', reason: 'stale-run' };
    if (!request.prompt.trim()) return { kind: 'rejected', reason: 'invalid-input' };
    if (this.turnClosing || this.stopRequested || this.exited) {
      return { kind: 'deferred', reason: 'turn-closing' };
    }
    if (!this.client || !this.sessionId || !this.promptInFlight) {
      return { kind: 'deferred', reason: 'turn-not-ready' };
    }
    try {
      const params = {
        sessionId: this.sessionId,
        text: request.prompt,
        interjectionId: `aria-${request.requestId}`,
      };
      try {
        await this.client.request('x.ai/interject', params, 5_000);
      } catch (error) {
        if (!(error instanceof GrokRpcError) || error.code !== -32601) throw error;
        await this.client.request('_x.ai/interject', params, 5_000);
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
    const queue = new RunQueue();
    const messages = new GrokMessageTranslator();
    let offNotification: (() => void) | undefined;
    let offClosed: (() => void) | undefined;
    let model = this.options.model && this.options.model !== 'default' ? this.options.model : undefined;
    try {
      this.client = await this.runtime.client();
      model ??= this.client.modelState?.currentModelId;
      offNotification = this.client.onNotification((notification) => {
        queue.push({ type: 'notification', notification });
      });
      offClosed = this.client.onClosed((error) => queue.push({ type: 'closed', error }));

      const cwd = this.options.cwd!;
      const sessionParams = {
        cwd,
        mcpServers: [],
        _meta: { yoloMode: this.runtime.fullAccess },
      };
      const requestedSessionId = this.options.sessionId;
      const session = requestedSessionId
        ? await this.loadOrCreateSession(requestedSessionId, sessionParams)
        : await this.client.request<GrokSessionResult>('session/new', sessionParams);
      this.sessionId = extractSessionId(session, requestedSessionId);
      if (!this.sessionId) throw new Error('Grok ACP session response did not include sessionId');
      this.runtime.bindSession(this.sessionId, this);

      const requestedEffort = this.options.reasoningEffort && this.options.reasoningEffort !== 'default'
        ? this.options.reasoningEffort
        : undefined;
      if (model && (this.options.model !== undefined || requestedEffort)) {
        await this.client.request('session/set_model', {
          sessionId: this.sessionId,
          modelId: model,
          ...(requestedEffort
            ? { _meta: { reasoningEffort: requestedEffort } }
            : {}),
        });
      }

      yield {
        type: 'system',
        sessionId: this.sessionId,
        cwd,
        ...(model ? { model } : {}),
        ...(this.options.reasoningEffort && this.options.reasoningEffort !== 'default'
          ? { reasoningEffort: this.options.reasoningEffort }
          : {}),
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
      void this.client.request<GrokPromptResult>('session/prompt', {
        sessionId: this.sessionId,
        prompt,
      }, 0).then(
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
          this.turnClosing = true;
          for (const event of messages.finish(false)) yield event;
          yield {
            type: 'error',
            message: signal.error.message,
            terminationReason: this.stopRequested ? 'interrupted' : 'failed',
          };
          return;
        }
        if (signal.type === 'prompt-result') {
          this.promptInFlight = false;
          this.turnClosing = true;
          for (const event of messages.finish(!this.stopRequested)) yield event;
          const usage = extractGrokUsage(signal.result);
          if (usage) {
            yield { type: 'usage', ...usage };
          }
          this.runtime.setLatestModel(model);
          yield {
            type: 'done',
            sessionId: this.sessionId,
            terminationReason: this.stopRequested ? 'interrupted' : 'normal',
          };
          return;
        }

        const notification = signal.notification;
        if (notification.method === '_x.ai/models/update') {
          const params = isRecord(notification.params) ? notification.params : undefined;
          if (typeof params?.currentModelId === 'string') model = params.currentModelId;
          continue;
        }
        if (notification.method !== 'session/update') continue;
        const params = isRecord(notification.params)
          ? notification.params as GrokSessionUpdateParams
          : undefined;
        if (params?.sessionId && params.sessionId !== this.sessionId) continue;
        const update = isRecord(params?.update)
          ? params.update
          : isRecord(params?.sessionUpdate)
            ? params.sessionUpdate
            : params && typeof params.sessionUpdate === 'string'
              ? { ...params, sessionUpdate: params.sessionUpdate }
              : undefined;
        if (!update) continue;
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
      this.turnClosing = true;
      offNotification?.();
      offClosed?.();
      queue.end();
      this.exited = true;
      this.resolveExit();
      this.runtime.untrack(this);
    }
  }

  private async loadOrCreateSession(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<GrokSessionResult> {
    try {
      return await this.client!.request<GrokSessionResult>('session/load', { sessionId, ...params });
    } catch (error) {
      if (!isMissingSessionError(error)) throw error;
      return this.client!.request<GrokSessionResult>('session/new', params);
    }
  }
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

function modelState(value: GrokModelState | undefined): GrokModelState | undefined {
  return value && typeof value === 'object' ? value : undefined;
}

type GrokModelMeta = NonNullable<NonNullable<GrokModelState['availableModels']>[number]['_meta']>;

function reasoningEfforts(meta: GrokModelMeta | undefined):
  NonNullable<ModelOption['reasoning']> {
  const options: Array<{ value: string; label: string }> = [];
  let defaultValue: string | undefined;
  for (const entry of meta?.reasoningEfforts ?? []) {
    const value = typeof entry === 'string'
      ? entry
      : typeof entry.id === 'string'
        ? entry.id
        : entry.value;
    if (!value || options.some((option) => option.value === value)) continue;
    options.push({ value, label: value });
    if (typeof entry !== 'string' && entry.default === true) defaultValue = value;
  }
  if (!defaultValue && meta?.reasoningEffort && options.some((option) => option.value === meta.reasoningEffort)) {
    defaultValue = meta.reasoningEffort;
  }
  return { options, ...(defaultValue ? { defaultValue } : {}) };
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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Grok model listing aborted');
}
