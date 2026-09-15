import { createHash } from 'node:crypto';

export const SPACE_CONTRACT_VERSION = 1 as const;
export type PrincipalKind = 'user' | 'service' | 'agent';
export interface SourceAuthority {
  readonly profileId: string;
  readonly providerId: string;
  readonly accountId: string;
  /** A provider's actual tenant identifier, never a product brand. */
  readonly tenantId?: string;
}
export interface PrincipalRef {
  readonly profileId: string;
  readonly authorityId: string;
  readonly kind: PrincipalKind;
  readonly subjectId: string;
}
export interface ConversationRef {
  readonly profileId: string;
  readonly authorityId: string;
  readonly instanceId: string;
  readonly conversationId: string;
}
export type SpaceKey =
  | { readonly kind: 'default'; readonly profileId: string }
  | { readonly kind: 'shared'; readonly profileId: string; readonly authorityId: string; readonly trustDomain: string }
  | { readonly kind: 'user'; readonly profileId: string; readonly principal: PrincipalRef };

export function opaqueId(namespace: string, fields: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify([SPACE_CONTRACT_VERSION, namespace, ...fields])).digest('hex');
}
export function requiredId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}
export function authorityId(source: SourceAuthority): string {
  return opaqueId('authority', [
    requiredId(source.profileId, 'profile'), requiredId(source.providerId, 'provider'),
    requiredId(source.accountId, 'account'), source.tenantId === undefined ? null : requiredId(source.tenantId, 'tenant'),
  ]);
}
export function principalId(principal: PrincipalRef): string {
  if (!['user', 'service', 'agent'].includes(principal.kind)) throw new Error('invalid principal kind');
  return opaqueId('principal', [
    requiredId(principal.profileId, 'profile'), requiredId(principal.authorityId, 'authority'),
    principal.kind, requiredId(principal.subjectId, 'subject'),
  ]);
}
export function conversationId(conversation: ConversationRef): string {
  return opaqueId('conversation', [
    requiredId(conversation.profileId, 'profile'), requiredId(conversation.authorityId, 'authority'),
    requiredId(conversation.instanceId, 'instance'), requiredId(conversation.conversationId, 'conversation'),
  ]);
}
export function spaceId(key: SpaceKey): string {
  requiredId(key.profileId, 'profile');
  switch (key.kind) {
    case 'default': return opaqueId('space', ['default', key.profileId]);
    case 'shared': return opaqueId('space', ['shared', key.profileId, requiredId(key.authorityId, 'authority'), requiredId(key.trustDomain, 'trust domain')]);
    case 'user':
      if (key.principal.kind !== 'user' || key.principal.profileId !== key.profileId) throw new Error('invalid user space owner');
      return opaqueId('space', ['user', key.profileId, principalId(key.principal)]);
    default: throw new Error('invalid space kind');
  }
}
export interface AudienceObservation {
  readonly conversation: ConversationRef;
  readonly sender: PrincipalRef;
  readonly selfId: string;
  readonly kind: 'direct' | 'group' | 'resource';
  readonly authenticated: boolean;
  readonly complete: boolean;
  readonly humans: readonly string[];
  readonly agents: readonly string[];
  readonly revision: number;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly trustDomain: string;
}
export type SpaceRoutingResult =
  | { ok: true; key: SpaceKey; audienceKey: string; private: boolean }
  | { ok: false; code: 'access-denied' | 'identity-unverified' | 'audience-unverified' };

/** No provider I/O and no interpretation of mentions, prompt text or model output. */
export function routeSpace(input: {
  mode?: 'personal' | 'team';
  profileId: string;
  admitted: boolean;
  observation: AudienceObservation;
  now: number;
}): SpaceRoutingResult {
  const { observation: o } = input;
  if (!input.admitted) return { ok: false, code: 'access-denied' };
  if (!o.authenticated || o.conversation.profileId !== input.profileId || o.sender.profileId !== input.profileId
    || o.sender.authorityId !== o.conversation.authorityId) {
    return { ok: false, code: 'identity-unverified' };
  }
  principalId(o.sender);
  if (input.mode !== 'team') {
    return { ok: true, key: { kind: 'default', profileId: input.profileId }, audienceKey: 'personal-compatibility', private: false };
  }
  if (!o.selfId || !Number.isSafeInteger(o.revision) || o.revision < 0
    || !Number.isFinite(o.observedAt) || o.observedAt > input.now || !Number.isFinite(o.expiresAt) || o.expiresAt <= input.now
    || !o.complete || new Set(o.humans).size !== o.humans.length || new Set(o.agents).size !== o.agents.length
    || !o.agents.includes(o.selfId) || o.humans.some((id) => !id || o.agents.includes(id))) {
    return { ok: false, code: 'audience-unverified' };
  }
  const senderPresent = o.sender.kind === 'user' ? o.humans.includes(o.sender.subjectId)
    : o.sender.kind === 'agent' ? o.agents.includes(o.sender.subjectId) : o.kind === 'resource';
  if (!senderPresent) return { ok: false, code: 'identity-unverified' };
  const exclusive = o.humans.length === 1 && o.agents.length === 1 && o.agents[0] === o.selfId
    && o.sender.kind === 'user' && o.humans[0] === o.sender.subjectId;
  if (o.kind === 'direct' && !exclusive) return { ok: false, code: 'audience-unverified' };
  const privateAudience = o.kind !== 'resource' && exclusive;
  return {
    ok: true,
    key: privateAudience
      ? { kind: 'user', profileId: input.profileId, principal: o.sender }
      : { kind: 'shared', profileId: input.profileId, authorityId: o.conversation.authorityId, trustDomain: o.trustDomain },
    private: privateAudience,
    audienceKey: opaqueId('audience', [o.kind, o.selfId, [...o.humans].sort(), [...o.agents].sort()]),
  };
}
