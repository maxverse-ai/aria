import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { EngineProfileConfig } from '../config/profile-schema';
import { clampAccess } from '../config/permissions';
import type { AgentAttachment, RunPolicyAllow } from '../policy/run-policy';
import type { StartRunFlowInput, RecordRunSessionEventInput } from '../bot/run-flow';
import type { EngineRuntime } from '../agent/runtime/types';
import { runtimeQueries } from '../agent/runtime/queries';
import type { RunExecution } from '../runtime/run-executor';
import { SpaceAuthorization, type AuthorizedSpaceContext } from './authorization';
import { SpaceStateStore, type SpaceStateView } from './state';
import { SpaceRuntimeRegistry, spaceRuntimeRequest } from './runtime-registry';
import { assertConfinedPath } from './paths';
import { spacePolicyProfile } from './policy-profile';
import type { RunTools } from '../runtime/run-tools';

/** Composition-owned services; presence requires an explicitly prepared team host. */
export class ExecutionSpaceServices {
  private closed = false;
  private readonly policies = new WeakMap<RunPolicyAllow, { context: AuthorizedSpaceContext; state: SpaceStateView; scopeId: string }>();
  private readonly active = new Map<string, { execution: RunExecution; context: AuthorizedSpaceContext }>();
  private readonly admittedAttachments = new WeakMap<AuthorizedSpaceContext, Set<string>>();
  private readonly unsubscribe: () => void;
  private toolOwner?: RunTools;
  readonly runTools: RunTools = {
    prepare: (context, runId) => {
      if (this.closed) return Promise.reject(new Error('execution spaces are closed'));
      this.authorization.inspect(context);
      return this.toolOwner?.prepare(context, runId) ?? Promise.resolve(undefined);
    },
    close: () => this.toolOwner?.close() ?? Promise.resolve(),
    activeWork: () => this.toolOwner?.activeWork?.() ?? 0,
  };
  installTools(owner: RunTools): void {
    if (this.closed || this.toolOwner) throw new Error('space native tools already owned or closed');
    this.toolOwner = owner;
  }
  constructor(readonly authorization: SpaceAuthorization, readonly state: SpaceStateStore,
    readonly runtimes: SpaceRuntimeRegistry) {
    const stopInvalid = () => {
      for (const { context, execution } of this.active.values()) {
        try { authorization.inspect(context); }
        catch { void execution.stop().catch(() => undefined); }
      }
    };
    const offBinding = authorization.bindings.onInvalidated(stopInvalid);
    const offGrant = authorization.onRevoked(stopInvalid);
    this.unsubscribe = () => { offBinding(); offGrant(); };
  }
  async prepare(input: StartRunFlowInput): Promise<StartRunFlowInput> {
    if (this.closed) throw new Error('execution spaces are closed');
    const context = input.spaceContext;
    if (!context) throw new Error('team execution requires a trusted space context');
    const snapshot = this.authorization.inspect(context);
    if (snapshot.principal.subjectId !== input.scope.actorId || snapshot.principal.profileId !== input.observability?.profile
      || (input.scopeId !== snapshot.scopeRef && input.scopeId !== snapshot.executionScope)) throw new Error('space execution context mismatch');
    const state = await this.state.view(context);
    const profileConfig = spacePolicyProfile(input.profileConfig, state.paths, snapshot.accessCeiling);
    const requested = state.workspaces.cwdFor(snapshot.executionScope) ?? state.paths.workspace;
    await assertConfinedPath(state.paths.workspace, requested);
    for (const attachment of input.attachments) {
      if (attachment.decision === 'accepted' && (!attachment.path || !this.admittedAttachments.get(context)?.has(attachment.path))) {
        throw new Error('attachment requires trusted source admission');
      }
    }
    if (this.closed) throw new Error('execution spaces are closed');
    return { ...input, scopeId: snapshot.executionScope, sessions: state.sessions,
      sessionCatalog: state.sessionCatalog, workspaces: state.workspaces, profileConfig };
  }
  /** Host source adapters call this only after downloading/verifying input media.
   * A worker JSON path or model-produced path is never an attachment grant. */
  async admitAttachments(context: AuthorizedSpaceContext, attachments: AgentAttachment[]): Promise<AgentAttachment[]> {
    if (this.closed) throw new Error('execution spaces are closed');
    const staged = await this.stageAttachments(context, await this.state.view(context), attachments);
    const paths = this.admittedAttachments.get(context) ?? new Set<string>();
    for (const attachment of staged) if (attachment.decision === 'accepted' && attachment.path) paths.add(attachment.path);
    this.admittedAttachments.set(context, paths);
    return staged;
  }
  /** Proof of source admission is turn-bound; an arbitrary worker path is not proof. */
  isAdmittedAttachment(context: AuthorizedSpaceContext, path: string): boolean {
    if (this.closed) throw new Error('execution spaces are closed');
    this.authorization.inspect(context);
    return this.admittedAttachments.get(context)?.has(path) ?? false;
  }
  async recordPolicy(policy: RunPolicyAllow, context: AuthorizedSpaceContext): Promise<void> {
    const snapshot = this.authorization.inspect(context);
    this.policies.set(policy, { context, state: await this.state.view(context), scopeId: snapshot.executionScope });
  }
  recordInput(input: RecordRunSessionEventInput): RecordRunSessionEventInput {
    const bound = this.policies.get(input.policy);
    if (!bound) throw new Error('session event has no space ownership');
    this.authorization.inspect(bound.context);
    return { ...input, scopeId: bound.scopeId, sessions: bound.state.sessions, sessionCatalog: bound.state.sessionCatalog,
      event: input.event.type === 'system' ? { ...input.event, cwd: input.policy.cwdRealpath } : input.event };
  }
  track(execution: RunExecution, context: AuthorizedSpaceContext): void {
    this.authorization.inspect(context);
    this.active.set(execution.runId, { execution, context });
    void (async () => {
      try { for await (const _ of execution.subscribe()) { /* lifetime observer */ } }
      finally { this.active.delete(execution.runId); }
    })().catch(() => undefined);
  }
  assertSteering(context: AuthorizedSpaceContext, scopeId: string): void {
    const incoming = this.authorization.inspect(context);
    const scope = this.scope(context, scopeId);
    const owned = [...this.active.values()].find(({ execution }) => execution.scopeId === scope);
    if (!owned) throw new Error('active space run is unavailable');
    const original = this.authorization.inspect(owned.context);
    if (original.binding.ref !== incoming.binding.ref
      || clampAccess(original.accessCeiling, incoming.accessCeiling, incoming.accessCeiling) !== original.accessCeiling) throw new Error('steering grant has a lower ceiling');
  }
  untrack(runId: string): void { this.active.delete(runId); }
  scope(context: AuthorizedSpaceContext, scopeId: string): string {
    const value = this.authorization.inspect(context);
    if (scopeId !== value.scopeRef && scopeId !== value.executionScope) throw new Error('space scope mismatch');
    return value.executionScope;
  }
  async query<T>(context: AuthorizedSpaceContext, operation: (runtime: EngineRuntime) => Promise<T>): Promise<T> {
    const lease = await this.runtimes.acquire(spaceRuntimeRequest(context, this.authorization, 'query'));
    try {
      const result = await operation(lease.runtime);
      this.authorization.inspect(context);
      return result;
    } finally { lease.release(); }
  }
  async history(context: AuthorizedSpaceContext, cwd: string, limit: number) {
    const snapshot = this.authorization.inspect(context);
    const view = await this.state.view(context);
    await assertConfinedPath(view.paths.workspace, cwd);
    const catalog = () => view.sessionCatalog.entries()
      .filter(entry => (entry.threadId || entry.sessionId) && entry.cwdRealpath === cwd
        && (snapshot.binding.key.kind !== 'shared' || entry.scopeId === snapshot.executionScope))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, Math.min(100, limit)))
      .map(entry => ({ id: (entry.threadId ?? entry.sessionId)!, preview: entry.lastSummary ?? '', updatedAtMs: entry.updatedAt, detail: 'Aria session catalog' }));
    // Shared execution state is a resource-reuse choice. History selection
    // remains tied to the original conversation scope and audience epoch.
    if (snapshot.binding.key.kind === 'shared') return catalog();
    return this.query(context, async (runtime) => {
      const query = runtimeQueries(runtime).listHistory;
      return query ? query({ cwd, limit: Math.max(1, Math.min(100, limit)) }) : catalog();
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    const closed = await Promise.allSettled([
      this.runTools.close(),
      ...[...this.active.values()].map(({ execution }) => execution.stop()),
    ]);
    const disposed = await Promise.allSettled([this.runtimes.dispose(), this.state.flush()]);
    const failure = [...closed, ...disposed].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
  }
  private async stageAttachments(context: AuthorizedSpaceContext, state: SpaceStateView, attachments: AgentAttachment[]): Promise<AgentAttachment[]> {
    const root = join(state.paths.data, 'attachments');
    await assertConfinedPath(state.paths.engine, root); await mkdir(root, { recursive: true, mode: 0o700 });
    return Promise.all(attachments.map(async (attachment) => {
      if (attachment.decision !== 'accepted' || !attachment.path) return attachment;
      this.authorization.inspect(context);
      const name = createHash('sha256').update(attachment.hash ?? attachment.path).digest('hex');
      const suffix = basename(attachment.path).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      const path = await assertConfinedPath(root, join(root, `${name}-${suffix}`));
      await copyFile(attachment.path, path);
      this.authorization.inspect(context);
      return { ...attachment, path };
    }));
  }
}
