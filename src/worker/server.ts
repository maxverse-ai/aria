import type { SpaceOperationGate, SpaceOperation } from '../space/operation-gate';
import { principalId, type PrincipalRef } from '../space/identity';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ProfileConversationHost } from '../conversation/profile-host';
import {
  ARIA_WORKER_METHODS,
  ARIA_WORKER_PROTOCOL_VERSION,
  parseRequest,
  parseRunStartParams,
  requiredScopeRef,
  WorkerProtocolError,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcSuccess,
  type RunAcceptedResult,
  type WorkerRunCompleted,
  type WorkerRunEvent,
  type WorkerRunFailed,
} from './protocol';

export interface AriaWorkerServerOptions {
  /** Established by the local controller transport, never taken from request JSON. */
  spaceSession?: { gate: SpaceOperationGate; principal: PrincipalRef; resolve(scopeRef: string): Promise<SpaceOperation>; canShutdown?: boolean };
  input: Readable;
  output: Writable;
  host: ProfileConversationHost;
  profile: string;
  workerVersion: string;
}

interface OperationRecord {
  spaceOperation?: SpaceOperation;
  scopeRef: string;
  state: RunAcceptedResult['state'];
  sequence: number;
  runId?: string;
}

interface DispatchResult {
  result: unknown;
  afterResponse?: () => void;
  shutdown?: boolean;
}

/** Newline-delimited JSON-RPC server used by machine-local controllers. */
export class AriaWorkerServer {
  private readonly operations = new Map<string, OperationRecord>();
  private readonly completed = new Set<string>();
  private lines?: ReadlineInterface;
  private stopping?: Promise<void>;
  private processing: Promise<void> = Promise.resolve();
  private resolveDone?: () => void;
  private done = new Promise<void>((resolve) => { this.resolveDone = resolve; });

  constructor(private readonly options: AriaWorkerServerOptions) {
    if (options.host.requiresSpaceAuthorization && !options.spaceSession) throw new Error('team worker requires an authenticated controller session');
  }

  private async authorizeScope(scopeRef: string, actorRef?: string): Promise<SpaceOperation | undefined> {
    const session = this.options.spaceSession;
    if (!session) return undefined;
    const operation = await session.resolve(scopeRef);
    await session.gate.refresh(operation);
    const snapshot = session.gate.services.authorization.inspect(operation.context);
    if (snapshot.scopeRef !== scopeRef || principalId(snapshot.principal) !== principalId(session.principal)
      || (actorRef !== undefined && actorRef !== snapshot.principal.subjectId)) throw new Error('worker actor or scope is not authorized');
    return operation;
  }

  async serve(): Promise<void> {
    if (this.lines) throw new Error('Aria worker server is already serving');
    this.lines = createInterface({ input: this.options.input, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      this.processing = this.processing.then(() => this.handleLine(line));
    });
    this.lines.once('close', () => {
      void this.processing.finally(() => this.stop());
    });
    return this.done;
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.lines?.close();
      await this.options.host.close();
      this.resolveDone?.();
      this.resolveDone = undefined;
    })();
    return this.stopping;
  }

  private async handleLine(line: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.writeFailure(null, new WorkerProtocolError(-32700, 'invalid JSON'));
      return;
    }

    let request;
    try {
      request = parseRequest(raw);
      const dispatched = await this.dispatch(request.method, request.params);
      this.writeSuccess(request.id, dispatched.result);
      dispatched.afterResponse?.();
      if (dispatched.shutdown) await this.stop();
    } catch (error) {
      this.writeFailure(request?.id ?? null, error);
    }
  }

  private async dispatch(method: string, params: unknown): Promise<DispatchResult> {
    switch (method) {
    case 'runtime.handshake':
      return {
        result: {
          protocolVersion: ARIA_WORKER_PROTOCOL_VERSION,
          workerVersion: this.options.workerVersion,
          profile: this.options.profile,
          engine: this.options.host.descriptor,
          methods: ARIA_WORKER_METHODS,
        },
      };
    case 'runtime.health':
      return {
        result: {
          ready: !this.stopping,
          activeOperations: [...this.operations.values()].filter(
            (operation) => operation.state === 'accepted' || operation.state === 'running',
          ).length,
          completedOperations: this.completed.size,
        },
      };
    case 'run.start':
      return this.prepareRun(params);
    case 'run.interrupt': {
      const scopeRef = requiredScopeRef(params);
      const operation = await this.authorizeScope(scopeRef);
      return { result: { scopeRef, interrupted: await (operation ? this.options.host.interrupt(scopeRef, operation.context) : this.options.host.interrupt(scopeRef)) } };
    }
    case 'session.reset': {
      const scopeRef = requiredScopeRef(params);
      const operation = await this.authorizeScope(scopeRef);
      return { result: { scopeRef, ...await (operation ? this.options.host.reset(scopeRef, operation.context) : this.options.host.reset(scopeRef)) } };
    }
    case 'runtime.shutdown':
      if (this.options.spaceSession && !this.options.spaceSession.canShutdown) throw new Error('worker shutdown requires controller management authority');
      return { result: { accepted: true }, shutdown: true };
    default:
      throw new WorkerProtocolError(-32601, `method not found: ${method}`);
    }
  }

  private async prepareRun(params: unknown): Promise<DispatchResult> {
    const input = parseRunStartParams(params);
    const spaceOperation = await this.authorizeScope(input.scopeRef, input.actorRef);
    const existing = this.operations.get(input.operationId);
    if (existing) {
      if (existing.scopeRef !== input.scopeRef || existing.spaceOperation?.bindingRef !== spaceOperation?.bindingRef) {
        throw new WorkerProtocolError(
          -32602,
          'operationId is already bound to another scopeRef',
        );
      }
      return {
        result: {
          operationId: input.operationId,
          state: existing.state,
          duplicate: true,
          ...(existing.runId ? { runId: existing.runId } : {}),
        } satisfies RunAcceptedResult,
      };
    }

    this.operations.set(input.operationId, {
      ...(spaceOperation ? { spaceOperation } : {}),
      scopeRef: input.scopeRef,
      state: 'accepted',
      sequence: 0,
    });
    return {
      result: {
        operationId: input.operationId,
        state: 'accepted',
        duplicate: false,
      } satisfies RunAcceptedResult,
      afterResponse: () => { void this.executeRun(input); },
    };
  }

  private async executeRun(input: ReturnType<typeof parseRunStartParams>): Promise<void> {
    const operation = this.operations.get(input.operationId);
    if (!operation) return;
    operation.state = 'running';
    try {
      const execute = () => this.options.host.run({
        ...(operation.spaceOperation ? { spaceContext: operation.spaceOperation.context, actorKind: this.options.spaceSession!.principal.kind } : {}),
        scopeId: input.scopeRef,
        actorId: input.actorRef,
        prompt: input.prompt,
        authorized: input.authorization.decision === 'allow',
        attachments: input.attachments ?? [],
        ...(input.source ? { source: input.source } : {}),
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        onEvent: (event) => {
          if (operation.spaceOperation) this.options.spaceSession!.gate.services.authorization.inspect(operation.spaceOperation.context);
          this.notify('run.event', {
            operationId: input.operationId,
            sequence: ++operation.sequence,
            event,
          } satisfies WorkerRunEvent);
        },
      });
      const result = operation.spaceOperation ? await this.options.spaceSession!.gate.run(operation.spaceOperation, execute) : await execute();
      if (result.ok) {
        operation.state = 'completed';
        operation.runId = result.runId;
        this.completed.add(input.operationId);
        this.notify('run.completed', {
          operationId: input.operationId,
          sequence: ++operation.sequence,
          runId: result.runId,
          content: result.content,
        } satisfies WorkerRunCompleted);
      } else {
        operation.state = 'failed';
        this.completed.add(input.operationId);
        this.notify('run.failed', {
          operationId: input.operationId,
          sequence: ++operation.sequence,
          code: result.code,
          message: result.userVisible,
        } satisfies WorkerRunFailed);
      }
    } catch (error) {
      operation.state = 'failed';
      this.completed.add(input.operationId);
      this.notify('run.failed', {
        operationId: input.operationId,
        sequence: ++operation.sequence,
        code: 'worker-run-failed',
        message: error instanceof Error ? error.message : String(error),
      } satisfies WorkerRunFailed);
    }
  }

  private writeSuccess(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result } satisfies JsonRpcSuccess);
  }

  private writeFailure(id: JsonRpcId | null, error: unknown): void {
    const protocolError = error instanceof WorkerProtocolError
      ? error
      : new WorkerProtocolError(-32603, error instanceof Error ? error.message : String(error));
    this.write({
      jsonrpc: '2.0',
      id,
      error: {
        code: protocolError.code,
        message: protocolError.message,
        ...(protocolError.data === undefined ? {} : { data: protocolError.data }),
      },
    } satisfies JsonRpcFailure);
  }

  private notify(method: string, params: unknown): void {
    if (this.stopping) return;
    this.write({ jsonrpc: '2.0', method, params } satisfies JsonRpcNotification);
  }

  private write(message: JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification): void {
    this.options.output.write(`${JSON.stringify(message)}\n`);
  }
}
