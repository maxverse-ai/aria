import { AsyncLocalStorage } from 'node:async_hooks';
import { ExecutionSpaceServices } from './services';
import { ExecutionGrantStore } from './grants';
import type { AuthorizedSpaceContext } from './authorization';
import type { ChannelIdentityAdapter, ChannelIdentityRequest } from '../channel/identity/types';
import { clampAccess, type AccessMode } from '../config/permissions';
import { principalId, type PrincipalRef } from './identity';
import { immutable } from './immutable';
import { SpaceResourceStore } from './resources';

export interface SpaceOperation {
  readonly context: AuthorizedSpaceContext;
  readonly request: ChannelIdentityRequest;
  readonly scopeRef: string;
  readonly executionScope: string;
  readonly bindingRef: string;
}
export interface SpaceOperationCheckpoint {
  readonly schema: 'aria.space.operation.v1';
  readonly grantRef: string;
  readonly principal: PrincipalRef;
  readonly bindingRef: string;
  readonly request: ChannelIdentityRequest;
  readonly scopeRef: string;
}
export interface SpaceAdmission {
  admitted: boolean;
  accessCeiling: AccessMode;
}
const current = new AsyncLocalStorage<{ gate: SpaceOperationGate; operation: SpaceOperation }>();

/** Host-only companion port. A decoded envelope cannot issue an operation. */
export class SpaceOperationGate {
  private readonly issued = new WeakSet<SpaceOperation>();
  readonly resources: SpaceResourceStore;
  constructor(readonly services: ExecutionSpaceServices, readonly identity: ChannelIdentityAdapter,
    readonly grants: ExecutionGrantStore,
    private readonly admission: (request: ChannelIdentityRequest) => SpaceAdmission | Promise<SpaceAdmission>,
    private readonly now = Date.now, resources?: SpaceResourceStore) {
    this.resources = resources ?? new SpaceResourceStore(services.authorization);
  }

  async enter(request: ChannelIdentityRequest, scopeRef: string): Promise<SpaceOperation> {
    const decision = await this.admission(request);
    const context = await this.services.authorization.authorize({
      observation: await this.identity.observe(request), scopeRef, ...decision, mode: 'team',
      expiresAt: this.now() + 24 * 60 * 60_000,
    });
    return this.issue(context, request, scopeRef);
  }
  /** Recover a sender inside an existing audience, without mutating its binding. */
  async admitHistory(original: SpaceOperation, request: ChannelIdentityRequest): Promise<SpaceOperation> {
    if (!this.issued.has(original)) throw new Error('untrusted space operation');
    if (request.conversationId !== original.request.conversationId || request.kind !== original.request.kind) {
      throw new Error('history audience differs from the active space operation');
    }
    this.services.authorization.inspect(original.context);
    const decision = await this.admission(request);
    if (!decision.admitted) throw new Error('access-denied');
    const context = await this.services.authorization.authorize({
      observation: await this.identity.observe(request), scopeRef: original.scopeRef,
      ...decision, mode: 'team', within: original.context,
    });
    return this.issue(context, request, original.scopeRef);
  }
  private issue(context: AuthorizedSpaceContext, request: ChannelIdentityRequest, scopeRef: string): SpaceOperation {
    const snapshot = this.services.authorization.inspect(context);
    if (snapshot.principal.subjectId !== request.senderId || snapshot.principal.kind !== request.senderKind
      || snapshot.sourceKind !== request.kind || snapshot.scopeRef !== scopeRef
      || snapshot.binding.conversation.conversationId !== request.conversationId) throw new Error('space operation identity mismatch');
    const result = Object.freeze({ context, request: immutable(request), scopeRef,
      executionScope: snapshot.executionScope, bindingRef: snapshot.binding.ref });
    this.issued.add(result);
    return result;
  }
  async refresh(operation: SpaceOperation): Promise<void> {
    if (!this.issued.has(operation)) throw new Error('untrusted space operation');
    // Refresh observation before checking the old handle: a long task may have
    // outlived the observation TTL, but never its saved authorization TTL.
    const fresh = await this.enter(operation.request, operation.scopeRef);
    if (fresh.bindingRef !== operation.bindingRef) throw new Error('result audience changed');
    const prior = this.services.authorization.inspect(operation.context);
    const next = this.services.authorization.inspect(fresh.context);
    if (principalId(prior.principal) !== principalId(next.principal)
      || clampAccess(prior.accessCeiling, next.accessCeiling, next.accessCeiling) !== prior.accessCeiling) {
      await this.grants.revokeIssued(prior.grantId);
      throw new Error('space authorization was reduced');
    }
  }
  async checkpoint(operation: SpaceOperation): Promise<SpaceOperationCheckpoint> {
    await this.refresh(operation);
    const grantRef = await this.grants.retain(operation.context);
    return immutable({ schema: 'aria.space.operation.v1', grantRef,
      principal: this.services.authorization.inspect(operation.context).principal,
      bindingRef: operation.bindingRef, request: operation.request, scopeRef: operation.scopeRef });
  }
  async batch(operations: readonly SpaceOperation[]): Promise<SpaceOperation> {
    const first = operations[0];
    if (!first) throw new Error('space batch is empty');
    for (const operation of operations) await this.refresh(operation);
    const owner = this.services.authorization.inspect(first.context);
    for (const operation of operations) {
      const next = this.services.authorization.inspect(operation.context);
      if (operation.bindingRef !== first.bindingRef || operation.executionScope !== first.executionScope
        || clampAccess(owner.accessCeiling, next.accessCeiling, next.accessCeiling) !== owner.accessCeiling) {
        throw new Error('batch has incompatible space authorization');
      }
    }
    return first;
  }
  async restore(checkpoint: SpaceOperationCheckpoint): Promise<SpaceOperation> {
    if (checkpoint.schema !== 'aria.space.operation.v1') throw new Error('unsupported space checkpoint');
    const fresh = await this.enter(checkpoint.request, checkpoint.scopeRef);
    if (fresh.bindingRef !== checkpoint.bindingRef) throw new Error('saved result audience changed');
    const context = this.grants.restore(checkpoint.grantRef, checkpoint.principal);
    const operation = this.issue(context, checkpoint.request, checkpoint.scopeRef);
    if (operation.bindingRef !== checkpoint.bindingRef) throw new Error('saved result binding mismatch');
    await this.refresh(operation);
    return operation;
  }
  async run<T>(operation: SpaceOperation, work: () => Promise<T>): Promise<T> {
    await this.refresh(operation);
    return current.run({ gate: this, operation }, async () => {
      let refreshing: Promise<void> | undefined;
      const timer = setInterval(() => {
        if (refreshing) return;
        refreshing = this.refresh(operation).catch(() => undefined).finally(() => { refreshing = undefined; });
      }, 5000);
      timer.unref();
      try {
        const result = await work();
        await this.refresh(operation);
        return result;
      } finally { clearInterval(timer); await refreshing; }
    });
  }
  active(): SpaceOperation {
    const value = current.getStore();
    if (!value || value.gate !== this || !this.issued.has(value.operation)) throw new Error('operation requires its original space binding');
    this.services.authorization.inspect(value.operation.context);
    return value.operation;
  }
  async deliver<T>(conversationId: string, send: () => Promise<T>): Promise<T> {
    const value = current.getStore();
    if (!value || value.gate !== this) throw new Error('delivery requires its original space binding');
    const operation = value.operation;
    if (operation.request.conversationId !== conversationId) throw new Error('foreign result destination');
    await this.refresh(operation);
    return send();
  }
}
