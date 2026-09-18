import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SpawnedProcessByStdio } from '../../../../platform/spawn';
import { log } from '../../../../core/logger';
import {
  isRecord,
  type GrokInitializeResult,
  type GrokJsonRpcId,
  type GrokJsonRpcNotification,
  type GrokJsonRpcRequest,
  type GrokJsonRpcResponse,
  type GrokModelState,
} from './protocol';

export type GrokAgentChild = SpawnedProcessByStdio<Writable, Readable, Readable>;
export type GrokServerRequestHandler = (request: GrokJsonRpcRequest) => Promise<unknown>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

export class GrokServerRequestError extends Error {
  constructor(
    message: string,
    readonly code = -32601,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'GrokServerRequestError';
  }
}

export class GrokRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'GrokRpcError';
  }
}

/** Minimal ACP/JSON-RPC client for the official `grok agent stdio` server. */
export class GrokAgentStdioClient {
  private nextId = 1;
  private readonly pending = new Map<GrokJsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(value: GrokJsonRpcNotification) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly lines;
  private closed = false;
  private closeError: Error | undefined;
  private initialized: GrokInitializeResult | undefined;
  private observedModelState: GrokModelState | undefined;

  constructor(
    private readonly child: GrokAgentChild,
    private readonly handleServerRequest: GrokServerRequestHandler,
  ) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    void this.readLoop();
    child.once('error', (error) => this.closeWithError(error));
    child.stdin.once('error', (error) => this.closeWithError(error));
    child.once('exit', (code, signal) => {
      this.closeWithError(
        new Error(`grok agent stdio exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`),
      );
    });
  }

  get initializeResult(): GrokInitializeResult | undefined {
    return this.initialized;
  }

  get modelState(): GrokModelState | undefined {
    return this.observedModelState ?? this.initialized?._meta?.modelState;
  }

  async initialize(version: string, hasApiKey: boolean): Promise<GrokInitializeResult> {
    const result = await this.request<GrokInitializeResult>('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'aria', title: 'Aria', version },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      _meta: {
        clientType: 'aria',
        startupHints: {
          nonInteractive: true,
          skipGitStatus: true,
          skipProjectLayout: true,
        },
      },
    });
    if (result.protocolVersion !== undefined && result.protocolVersion !== 1) {
      throw new Error(`unsupported Grok ACP protocol version: ${String(result.protocolVersion)}`);
    }
    if (result.agentCapabilities?.loadSession !== true) {
      throw new Error('Grok Agent stdio does not advertise ACP session resume support');
    }
    this.initialized = result;
    if (result._meta?.modelState) this.observedModelState = result._meta.modelState;

    const authMethods = new Set(
      (result.authMethods ?? []).map((method) => method.id).filter((id): id is string => !!id),
    );
    const advertisedDefault = result._meta?.defaultAuthMethodId;
    const methodId = advertisedDefault && authMethods.has(advertisedDefault)
      ? advertisedDefault
      : hasApiKey && authMethods.has('xai.api_key')
        ? 'xai.api_key'
        : authMethods.has('cached_token')
          ? 'cached_token'
          : undefined;
    if (methodId) {
      await this.request('authenticate', { methodId, _meta: { headless: true } });
    } else if (authMethods.size > 0) {
      throw new Error('Grok Build is not authenticated; run `grok login` or set XAI_API_KEY');
    }
    return result;
  }

  /**
   * `timeoutMs` bounds how long a single response may take; `<= 0` means no
   * deadline — the request then settles only on a response, abort, or
   * transport close. Long-lived requests (e.g. `session/prompt`, which spans
   * a whole turn) must use no deadline: turn duration is run-policy, decided
   * on the event stream, not a wire-level concern.
   */
  request<T>(
    method: string,
    params: unknown = {},
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error('grok agent stdio is closed'));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            const pending = this.pending.get(id);
            this.pending.delete(id);
            pending?.removeAbortListener?.();
            reject(new Error(`grok agent stdio request timed out: ${method}`));
          }, timeoutMs)
        : undefined;
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      };
      if (signal) {
        const onAbort = () => {
          if (this.pending.delete(id)) {
            clearTimeout(timer);
            reject(abortError(signal));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, pending);
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        pending.removeAbortListener?.();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(listener: (value: GrokJsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onClosed(listener: (error: Error) => void): () => void {
    if (this.closeError) {
      listener(this.closeError);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async dispose(graceMs = 2_000): Promise<void> {
    if (this.closed && (this.child.exitCode !== null || this.child.signalCode !== null)) return;
    this.markClosed(new Error('grok agent stdio disposed'));
    this.lines.close();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
          resolve();
        }, graceMs);
        this.child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private write(message: GrokJsonRpcRequest | GrokJsonRpcNotification | GrokJsonRpcResponse): void {
    if (this.closed) throw this.closeError ?? new Error('grok agent stdio is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const line of this.lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          log.warn('grok-agent-stdio', 'invalid-json', { line: trimmed.slice(0, 500) });
          continue;
        }
        if (!isRecord(parsed)) continue;
        if ('id' in parsed && !('method' in parsed)) {
          this.handleResponse(parsed);
        } else if (typeof parsed.method === 'string' && 'id' in parsed) {
          void this.handleRequest(parsed as unknown as GrokJsonRpcRequest);
        } else if (typeof parsed.method === 'string') {
          const notification = parsed as unknown as GrokJsonRpcNotification;
          if (notification.method === '_x.ai/models/update' && isRecord(notification.params)) {
            this.observedModelState = {
              ...(this.observedModelState ?? {}),
              ...(typeof notification.params.currentModelId === 'string'
                ? { currentModelId: notification.params.currentModelId }
                : {}),
              ...(Array.isArray(notification.params.availableModels)
                ? { availableModels: notification.params.availableModels }
                : {}),
            } as GrokModelState;
          }
          for (const listener of this.notificationListeners) listener(notification);
        }
      }
    } catch (error) {
      if (!this.closed) this.closeWithError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleResponse(raw: Record<string, unknown>): void {
    const id = raw.id as GrokJsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    const error = isRecord(raw.error) ? raw.error : undefined;
    if (error) {
      pending.reject(new GrokRpcError(
        typeof error.message === 'string' ? error.message : 'Grok ACP request failed',
        typeof error.code === 'number' ? error.code : -32603,
        error.data,
      ));
    } else {
      pending.resolve(raw.result);
    }
  }

  private async handleRequest(request: GrokJsonRpcRequest): Promise<void> {
    try {
      const result = await this.handleServerRequest(request);
      this.write({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      if (this.closed) return;
      const rpcError = error instanceof GrokServerRequestError
        ? error
        : new GrokServerRequestError(error instanceof Error ? error.message : String(error), -32603);
      try {
        this.write({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: rpcError.code,
            message: rpcError.message,
            ...(rpcError.data === undefined ? {} : { data: rpcError.data }),
          },
        });
      } catch {
        // The process closed while the asynchronous server request was being handled.
      }
    }
  }

  private closeWithError(error: Error): void {
    this.markClosed(error);
  }

  private markClosed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('grok agent stdio request aborted');
}
