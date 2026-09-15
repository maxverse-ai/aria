import { randomUUID } from 'node:crypto';
import { immutable } from './immutable';
import type { AccessMode } from '../config/permissions';
import { SpaceBindingStore, type SpaceBinding } from './bindings';
import {
  authorityId, conversationId, opaqueId, principalId, requiredId, routeSpace, spaceId,
  type AudienceObservation, type PrincipalKind, type PrincipalRef, type SourceAuthority,
} from './identity';

/** In-process handles; raw JSON from a model, channel envelope or worker cannot mint these. */
declare const observationBrand: unique symbol;
export interface TrustedObservation { readonly [observationBrand]: true }
declare const authorizationBrand: unique symbol;
export interface AuthorizedSpaceContext { readonly [authorizationBrand]: true }
export interface AuthorizedSpaceSnapshot {
  readonly principal: PrincipalRef;
  readonly sourceKind: AudienceObservation['kind'];
  readonly binding: SpaceBinding;
  readonly executionScope: string;
  readonly scopeRef: string;
  readonly grantId: string;
  readonly accessCeiling: AccessMode;
  readonly expiresAt: number;
}
export interface SpaceSource {
  readonly authorityId: string;
  observe(input: {
    conversationId: string; actorId: string; actorKind: PrincipalKind; selfId: string;
    kind: AudienceObservation['kind']; authenticated: boolean; complete: boolean;
    humans: readonly string[]; agents: readonly string[];
    revision: number; observedAt: number; expiresAt: number;
  }): TrustedObservation;
}

/** One profile's policy authority, shared by all of its execution sources. */
export class SpaceAuthorization {
  private readonly observations = new WeakMap<TrustedObservation, AudienceObservation>();
  private readonly contexts = new WeakMap<AuthorizedSpaceContext, AuthorizedSpaceSnapshot>();
  private readonly revokedGrants = new Set<string>();
  private readonly revocationListeners = new Set<() => void>();
  constructor(readonly profileId: string, readonly bindings: SpaceBindingStore, private readonly now = Date.now) {
    requiredId(profileId, 'profile');
  }

  /** Called by trusted composition, never by a decoded request or tool. */
  registerSource(source: SourceAuthority & { instanceId: string; trustDomain?: string }): SpaceSource {
    if (source.profileId !== this.profileId) throw new Error('source profile mismatch');
    const authority = authorityId(source);
    const instanceId = requiredId(source.instanceId, 'instance');
    const trustDomain = source.trustDomain ?? authority;
    return Object.freeze({
      authorityId: authority,
      observe: (input: Parameters<SpaceSource['observe']>[0]) => {
        const handle = Object.freeze({}) as TrustedObservation;
        const observation: AudienceObservation = Object.freeze({
          ...input, humans: Object.freeze([...input.humans]), agents: Object.freeze([...input.agents]),
          conversation: Object.freeze({ profileId: this.profileId, authorityId: authority, instanceId, conversationId: requiredId(input.conversationId, 'conversation') }),
          sender: Object.freeze({ profileId: this.profileId, authorityId: authority, kind: input.actorKind, subjectId: requiredId(input.actorId, 'actor') }),
          trustDomain,
        });
        this.observations.set(handle, observation);
        return handle;
      },
    });
  }

  async authorize(input: {
    observation: TrustedObservation; scopeRef: string; admitted: boolean;
    mode?: 'personal' | 'team'; accessCeiling: AccessMode; expiresAt?: number;
    /** Historical admission may issue a handle only within this live binding.
     * It must never bind, suspend, renew or invalidate the conversation. */
    within?: AuthorizedSpaceContext;
  }): Promise<AuthorizedSpaceContext> {
    const owner = input.within ? this.inspect(input.within) : undefined;
    const observation = this.observations.get(input.observation);
    if (!observation) throw new Error('untrusted space identity');
    const decision = routeSpace({ mode: input.mode, profileId: this.profileId, admitted: input.admitted, observation, now: this.now() });
    if (!decision.ok) {
      if (!owner) {
        this.bindings.suspend(observation.conversation, observation.revision);
        await this.bindings.flush();
      }
      throw new Error(decision.code);
    }
    requiredId(input.scopeRef, 'scope');
    if (owner && (conversationId(owner.binding.conversation) !== conversationId(observation.conversation)
      || owner.scopeRef !== input.scopeRef || owner.sourceKind !== observation.kind
      || owner.binding.spaceId !== spaceId(decision.key) || owner.binding.audienceKey !== decision.audienceKey
      || observation.revision < owner.binding.revision)) throw new Error('history audience differs from the active space operation');
    const binding = owner?.binding ?? this.bindings.bind(observation, decision);
    if (!owner) await this.bindings.flush();
    const expiresAt = Math.min(input.expiresAt ?? this.now() + 300_000, owner?.expiresAt ?? Infinity);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('space authorization expired');
    if (!['read-only', 'workspace', 'full'].includes(input.accessCeiling)) throw new Error('invalid access ceiling');
    const snapshot: AuthorizedSpaceSnapshot = Object.freeze({
      principal: observation.sender, sourceKind: observation.kind, binding,
      executionScope: input.mode !== 'team' ? input.scopeRef : opaqueId('execution-scope', [binding.ref, input.scopeRef]),
      scopeRef: input.scopeRef, grantId: randomUUID(), accessCeiling: input.accessCeiling, expiresAt,
    });
    const context = Object.freeze({}) as AuthorizedSpaceContext;
    this.contexts.set(context, snapshot);
    return context;
  }

  inspect(context: AuthorizedSpaceContext): AuthorizedSpaceSnapshot {
    const value = this.contexts.get(context);
    if (!value) throw new Error('untrusted space authorization');
    if (value.principal.profileId !== this.profileId || value.expiresAt <= this.now() || this.revokedGrants.has(value.grantId)) {
      throw new Error('space authorization expired or revoked');
    }
    this.bindings.assertCurrent(value.binding, this.now());
    return value;
  }
  /** Restore only from the host-owned grant ledger, after source authorization. */
  restore(snapshot: AuthorizedSpaceSnapshot): AuthorizedSpaceContext {
    principalId(snapshot.principal);
    if (snapshot.binding.conversation.profileId !== this.profileId
      || snapshot.principal.authorityId !== snapshot.binding.conversation.authorityId
      || !['direct', 'group', 'resource'].includes(snapshot.sourceKind)
      || !['read-only', 'workspace', 'full'].includes(snapshot.accessCeiling)
      || !Number.isFinite(snapshot.expiresAt)
      || !snapshot.grantId || !snapshot.scopeRef
      || (snapshot.binding.key.kind === 'user' && principalId(snapshot.binding.key.principal) !== principalId(snapshot.principal))
      || snapshot.executionScope !== (snapshot.binding.key.kind === 'default' ? snapshot.scopeRef
        : opaqueId('execution-scope', [snapshot.binding.ref, snapshot.scopeRef]))) throw new Error('invalid persisted space authorization');
    const context = Object.freeze({}) as AuthorizedSpaceContext;
    this.contexts.set(context, immutable(snapshot));
    this.inspect(context);
    return context;
  }
  assertPrincipal(context: AuthorizedSpaceContext, principal: PrincipalRef): void {
    if (principalId(this.inspect(context).principal) !== principalId(principal)) throw new Error('space principal mismatch');
  }
  revoke(grantId: string): void {
    this.revokedGrants.add(grantId);
    for (const listener of this.revocationListeners) listener();
  }
  onRevoked(listener: () => void): () => void {
    this.revocationListeners.add(listener);
    return () => { this.revocationListeners.delete(listener); };
  }
}
