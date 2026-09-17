import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SpawnedProcessByStdio } from '../../../../platform/spawn';
import { log } from '../../../../core/logger';
import {
  isRecord,
  type DevinInitializeResult,
  type DevinJsonRpcId,
  type DevinJsonRpcNotification,
  type DevinJsonRpcRequest,
  type DevinJsonRpcResponse,
} from './protocol';

export type DevinAcpChild = SpawnedProcessByStdio<Writable, Readable, Readable>;
export type DevinServerRequestHandler = (request: DevinJsonRpcRequest) => Promise<unknown>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

export class DevinServerRequestError extends Error {
  constructor(
    message: string,
    readonly code = -32601,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'DevinServerRequestError';
  }
}

export class DevinRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'DevinRpcError';
  }
}

/** Raised when the ACP server requires a key the profile does not provide. */
export class DevinAuthRequiredError extends Error {
  constructor(readonly envKey: string) {
    super(
      `devin acp requires an API key supplied by the host: set ${envKey} ` +
      '(or devin.apiKeyEnv) for this profile',
    );
    this.name = 'DevinAuthRequiredError';
  }
}

export interface DevinAcpInitializeInput {
  version: string;
  /**
   * API key forwarded through `authenticate` `_meta.api_key`. `devin acp`
   * intentionally ignores local CLI credentials, so without a key session
   * methods fail server-side.
   */
  apiKey?: string;
  /** Auth method id override; defaults to the first advertised method. */
  authMethodId?: string;
  /**
   * When false (history queries), a missing key skips `authenticate` instead
   * of failing — session/list answers from the local session DB.
   */
  requireAuth?: boolean;
  /** Env var name the key was looked up under, for error messages. */
  apiKeyEnv?: string;
}

/** Minimal ACP/JSON-RPC client for the `devin acp` server. */
export class DevinAcpClient {
  private nextId = 1;
  private readonly pending = new Map<DevinJsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(value: DevinJsonRpcNotification) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly lines;
  private closed = false;
  private closeError: Error | undefined;
  private initialized: DevinInitializeResult | undefined;

  constructor(
    private readonly child: DevinAcpChild,
    private readonly handleServerRequest: DevinServerRequestHandler,
  ) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    void this.readLoop();
    child.once('error', (error) => this.closeWithError(error));
    child.stdin.once('error', (error) => this.closeWithError(error));
    child.once('exit', (code, signal) => {
      this.closeWithError(
        new Error(`devin acp exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`),
      );
    });
  }

  get initializeResult(): DevinInitializeResult | undefined {
    return this.initialized;
  }

  async initialize(input: DevinAcpInitializeInput): Promise<DevinInitializeResult> {
    const result = await this.request<DevinInitializeResult>('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'aria', title: 'Aria', version: input.version },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      _meta: { clientType: 'aria' },
    });
    if (result.protocolVersion !== undefined && result.protocolVersion !== 1) {
      throw new Error(`unsupported Devin ACP protocol version: ${String(result.protocolVersion)}`);
    }
    this.initialized = result;

    const authMethods = new Set(
      (result.authMethods ?? []).map((method) => method.id).filter((id): id is string => !!id),
    );
    if (authMethods.size === 0) return result;

    if (!input.apiKey) {
      if (input.requireAuth === false) return result;
      throw new DevinAuthRequiredError(input.apiKeyEnv ?? 'DEVIN_API_KEY');
    }
    const methodId = input.authMethodId && authMethods.has(input.authMethodId)
      ? input.authMethodId
      : authMethods.values().next().value!;
    await this.request('authenticate', {
      methodId,
      _meta: { api_key: input.apiKey, headless: true },
    }, 60_000);
    return result;
  }

  request<T>(
    method: string,
    params: unknown = {},
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error('devin acp is closed'));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.removeAbortListener?.();
        reject(new Error(`devin acp request timed out: ${method}`));
      }, timeoutMs);
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

  onNotification(listener: (value: DevinJsonRpcNotification) => void): () => void {
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
    this.markClosed(new Error('devin acp disposed'));
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

  private write(message: DevinJsonRpcRequest | DevinJsonRpcNotification | DevinJsonRpcResponse): void {
    if (this.closed) throw this.closeError ?? new Error('devin acp is closed');
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
          log.warn('devin-acp', 'invalid-json', { line: trimmed.slice(0, 500) });
          continue;
        }
        if (!isRecord(parsed)) continue;
        if ('id' in parsed && !('method' in parsed)) {
          this.handleResponse(parsed);
        } else if (typeof parsed.method === 'string' && 'id' in parsed) {
          void this.handleRequest(parsed as unknown as DevinJsonRpcRequest);
        } else if (typeof parsed.method === 'string') {
          const notification = parsed as unknown as DevinJsonRpcNotification;
          for (const listener of this.notificationListeners) listener(notification);
        }
      }
    } catch (error) {
      if (!this.closed) this.closeWithError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleResponse(raw: Record<string, unknown>): void {
    const id = raw.id as DevinJsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    const error = isRecord(raw.error) ? raw.error : undefined;
    if (error) {
      pending.reject(new DevinRpcError(
        typeof error.message === 'string' ? error.message : 'Devin ACP request failed',
        typeof error.code === 'number' ? error.code : -32603,
        error.data,
      ));
    } else {
      pending.resolve(raw.result);
    }
  }

  private async handleRequest(request: DevinJsonRpcRequest): Promise<void> {
    try {
      const result = await this.handleServerRequest(request);
      this.write({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      if (this.closed) return;
      const rpcError = error instanceof DevinServerRequestError
        ? error
        : new DevinServerRequestError(error instanceof Error ? error.message : String(error), -32603);
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
  return signal.reason instanceof Error ? signal.reason : new Error('devin acp request aborted');
}
