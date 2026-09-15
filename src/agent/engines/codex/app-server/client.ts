import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SpawnedProcessByStdio } from '../../../../platform/spawn';
import { log } from '../../../../core/logger';
import {
  isRecord,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol';

export type AppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;
type NotificationListener = (notification: JsonRpcNotification) => void;
type CloseListener = (error: Error) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

/** Minimal newline-delimited JSON-RPC client for `codex app-server --stdio`. */
export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private readonly lines;
  private closed = false;
  private closeError: Error | undefined;
  private disposal: Promise<void> | undefined;

  constructor(private readonly child: AppServerChild) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    void this.readLoop();
    child.once('error', (error) => this.closeWithError(error));
    child.stdin.once('error', (error) => this.closeWithError(error));
    child.once('exit', (code, signal) => {
      this.closeWithError(new Error(`codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });
  }

  async initialize(version: string): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'aria', title: 'Aria', version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized');
  }

  request<T>(
    method: string,
    params: unknown = {},
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('codex app-server is closed'));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.removeAbortListener?.();
        reject(new Error(`codex app-server request timed out: ${method}`));
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
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClosed(listener: CloseListener): () => void {
    if (this.closeError) {
      listener(this.closeError);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  dispose(graceMs = 10_000): Promise<void> {
    return this.disposal ??= this.closeProcess(graceMs);
  }

  private async closeProcess(graceMs: number): Promise<void> {
    if (this.closed && (this.child.exitCode !== null || this.child.signalCode !== null)) return;
    this.markClosed(new Error('codex app-server disposed'));
    this.lines.close();
    const exited = () => this.child.exitCode !== null || this.child.signalCode !== null;
    const waitForExit = async (stop: () => void) => {
      if (exited()) return;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.child.removeListener('exit', done); resolve(); };
        const timer = setTimeout(done, graceMs);
        this.child.once('exit', done);
        stop();
      });
    };
    // EOF is the normal stdio shutdown. Signalling an exec transport fences
    // its entire container, including a successful metadata-only probe.
    await waitForExit(() => { this.child.stdin.end(); });
    await waitForExit(() => { this.child.kill('SIGTERM'); });
    if (!exited()) this.child.kill('SIGKILL');
  }

  private write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (this.closed) throw new Error('codex app-server is closed');
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
          log.warn('codex-app-server', 'invalid-json', {
            line: trimmed.slice(0, 500),
          });
          continue;
        }
        if (!isRecord(parsed)) continue;
        if ('id' in parsed && !('method' in parsed)) {
          this.handleResponse(parsed);
        } else if (typeof parsed.method === 'string' && 'id' in parsed) {
          this.handleServerRequest(parsed as unknown as JsonRpcRequest);
        } else if (typeof parsed.method === 'string') {
          const notification = parsed as unknown as JsonRpcNotification;
          for (const listener of this.listeners) listener(notification);
        }
      }
    } catch (error) {
      if (!this.closed) this.closeWithError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleResponse(raw: Record<string, unknown>): void {
    const id = raw.id as JsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    const error = isRecord(raw.error) ? raw.error : undefined;
    if (error) {
      pending.reject(new Error(typeof error.message === 'string' ? error.message : 'codex app-server request failed'));
    } else {
      pending.resolve(raw.result);
    }
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    if (
      request.method === 'item/commandExecution/requestApproval' ||
      request.method === 'item/fileChange/requestApproval'
    ) {
      this.write({ id: request.id, result: { decision: 'decline' } });
      return;
    }
    this.write({
      id: request.id,
      error: {
        code: -32601,
        message: `unsupported server request: ${request.method}`,
      },
    });
  }

  private closeWithError(error: Error): void {
    this.markClosed(error);
  }

  private markClosed(error: Error): void {
    if (this.closed) return;
    this.closeError = error;
    this.closed = true;
    this.rejectPending(error);
    this.emitClosed(error.message);
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }

  private emitClosed(message: string): void {
    const notification: JsonRpcNotification = {
      method: 'aria/appServerClosed',
      params: { message },
    };
    for (const listener of this.listeners) listener(notification);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('codex app-server request aborted');
}
