import { createHash } from 'node:crypto';
import { nativeReadOpaqueId } from './native-read-identifiers';
import type { NativeReadRepository, NativeReadResourceDraft } from './native-read-repository';
import type {
  NativeChatMemberResource,
  NativeChatResource,
  NativeIdentityResource,
  NativeReadResolutionStatus,
} from './native-read-types';

export interface ChannelIdentityObservation {
  sourceIdentityId: string;
  kind: NativeIdentityResource['kind'];
  displayName?: string;
  resolutionStatus: NativeReadResolutionStatus;
  resolutionErrorCode?: string;
  observedAt: string;
}

export interface ChannelMemberObservation {
  identity: ChannelIdentityObservation;
  role: NativeChatMemberResource['role'];
  joinedAt?: string;
  leftAt?: string;
}

export interface ChannelChatObservation {
  sourceChatId: string;
  kind: NativeChatResource['kind'];
  name?: string;
  resolutionStatus: NativeReadResolutionStatus;
  resolutionErrorCode?: string;
  observedAt: string;
  owner?: ChannelIdentityObservation;
  members?: readonly ChannelMemberObservation[];
}

export interface ChannelIdentityProjectionResult {
  identities: number;
  chats: number;
  memberships: number;
}

export interface ChannelMessageIdentityObservation {
  sourceChatId: string;
  chatKind?: NativeChatResource['kind'];
  chatName?: string;
  observedAt: string;
  actor?: Pick<ChannelIdentityObservation, 'sourceIdentityId' | 'kind' | 'displayName'>;
}

/** Converts channel-owned identifiers and names into opaque native-read resources. */
export class ChannelIdentityReadProjector {
  constructor(
    private readonly profileId: string,
    private readonly repository: NativeReadRepository,
  ) {}

  /**
   * Lazily creates the opaque topology needed to join messages, sessions,
   * identities, and chats. Existing enriched resources are never downgraded.
   */
  async observeMessage(
    observation: ChannelMessageIdentityObservation,
  ): Promise<ChannelIdentityProjectionResult> {
    if (!observation.sourceChatId || !observation.observedAt) {
      throw new Error('message identity observation requires sourceChatId and observedAt');
    }

    let identities = 0;
    let chats = 0;
    let memberships = 0;
    const actor = observation.actor;
    if (actor) {
      const displayName = actor.displayName?.trim();
      identities += Number(await this.observeIdentity({
        sourceIdentityId: actor.sourceIdentityId,
        kind: actor.kind,
        ...(displayName ? { displayName } : {}),
        resolutionStatus: displayName ? 'resolved' : 'pending',
        observedAt: observation.observedAt,
      }));
    }

    if (!observation.chatKind) return { identities, chats, memberships };

    const chatId = nativeReadOpaqueId('chat', this.profileId, observation.sourceChatId);
    const chatResolved = observation.chatKind === 'p2p';
    chats += Number(await this.ensure({
      resourceType: 'chat',
      id: chatId,
      profileId: this.profileId,
      createdAt: observation.observedAt,
      updatedAt: observation.observedAt,
      kind: observation.chatKind,
      resolutionStatus: chatResolved ? 'resolved' : 'pending',
      ...(chatResolved ? { lastResolvedAt: observation.observedAt } : {}),
    }));
    const chatName = observation.chatName?.trim();
    if (chatName) {
      const existing = await this.repository.get<NativeChatResource>('chat', chatId);
      if (existing && (!existing.lastResolvedAt || Date.parse(existing.lastResolvedAt) <= Date.parse(observation.observedAt))) {
        await this.upsert({ ...existing, name: chatName, resolutionStatus: 'resolved',
          updatedAt: observation.observedAt, lastResolvedAt: observation.observedAt });
      }
    }

    if (actor) {
      const identityId = nativeReadOpaqueId('identity', this.profileId, actor.sourceIdentityId);
      memberships += Number(await this.ensure({
        resourceType: 'chat-member',
        id: nativeReadOpaqueId(
          'chat-member', this.profileId, observation.sourceChatId, actor.sourceIdentityId,
        ),
        profileId: this.profileId,
        createdAt: observation.observedAt,
        updatedAt: observation.observedAt,
        chatId,
        identityId,
        role: 'unknown',
      }));
    }

    return { identities, chats, memberships };
  }

  async project(observation: ChannelChatObservation): Promise<ChannelIdentityProjectionResult> {
    validateObservation(observation);
    const identities = deduplicateIdentities(observation);
    for (const identity of identities) await this.upsert(identityResource(this.profileId, identity));

    const chatId = nativeReadOpaqueId('chat', this.profileId, observation.sourceChatId);
    const ownerIdentityId = observation.owner
      ? nativeReadOpaqueId('identity', this.profileId, observation.owner.sourceIdentityId)
      : undefined;
    await this.upsert({
      resourceType: 'chat',
      id: chatId,
      profileId: this.profileId,
      createdAt: observation.observedAt,
      updatedAt: observation.observedAt,
      kind: observation.kind,
      ...(observation.name ? { name: observation.name } : {}),
      ...(ownerIdentityId ? { ownerIdentityId } : {}),
      resolutionStatus: observation.resolutionStatus,
      ...(observation.resolutionErrorCode ? { resolutionErrorCode: observation.resolutionErrorCode } : {}),
      lastResolvedAt: observation.observedAt,
    });

    const members = [...(observation.members ?? [])];
    if (observation.owner && !members.some((member) => member.identity.sourceIdentityId === observation.owner?.sourceIdentityId)) {
      members.push({ identity: observation.owner, role: 'owner' });
    }
    for (const member of members) {
      const identityId = nativeReadOpaqueId('identity', this.profileId, member.identity.sourceIdentityId);
      await this.upsert({
        resourceType: 'chat-member',
        id: nativeReadOpaqueId('chat-member', this.profileId, observation.sourceChatId, member.identity.sourceIdentityId),
        profileId: this.profileId,
        createdAt: observation.observedAt,
        updatedAt: observation.observedAt,
        chatId,
        identityId,
        role: member.role,
        ...(member.joinedAt ? { joinedAt: member.joinedAt } : {}),
        ...(member.leftAt ? { leftAt: member.leftAt } : {}),
      });
    }
    return { identities: identities.length, chats: 1, memberships: members.length };
  }

  private async upsert(resource: NativeReadResourceDraft): Promise<void> {
    const existing = await this.repository.get(resource.resourceType, resource.id);
    const stable = existing ? { ...resource, createdAt: existing.createdAt } : resource;
    const digest = createHash('sha256').update(JSON.stringify([1, stable])).digest('base64url');
    await this.repository.upsert({
      eventId: nativeReadOpaqueId('source-event', this.profileId, digest),
      changedAt: stable.updatedAt,
      resource: stable,
    });
  }

  private async ensure(resource: NativeReadResourceDraft): Promise<boolean> {
    const existing = await this.repository.get(resource.resourceType, resource.id);
    if (existing) return false;
    await this.upsert(resource);
    return true;
  }

  /**
   * Merge a channel message's identity snapshot without allowing a sparse or
   * older event to erase a previously resolved display name.
   */
  private async observeIdentity(identity: ChannelIdentityObservation): Promise<boolean> {
    const incoming = identityResource(this.profileId, identity);
    const existing = await this.repository.get<NativeIdentityResource>('identity', incoming.id);
    if (!existing) {
      await this.upsert(incoming);
      return true;
    }
    if (!identity.displayName || identity.resolutionStatus !== 'resolved') return false;
    if (
      existing.lastResolvedAt
      && Date.parse(existing.lastResolvedAt) > Date.parse(identity.observedAt)
    ) return false;
    const kind = identity.kind === 'unknown' ? existing.kind : identity.kind;
    if (
      existing.kind === kind
      && existing.displayName === identity.displayName
      && existing.resolutionStatus === 'resolved'
      && existing.lastResolvedAt === identity.observedAt
    ) return false;
    await this.upsert({
      ...incoming,
      kind,
      displayName: identity.displayName,
      resolutionStatus: 'resolved',
      lastResolvedAt: identity.observedAt,
    });
    return true;
  }
}

function identityResource(profileId: string, identity: ChannelIdentityObservation): Omit<NativeIdentityResource, 'revision'> {
  return {
    resourceType: 'identity',
    id: nativeReadOpaqueId('identity', profileId, identity.sourceIdentityId),
    profileId,
    createdAt: identity.observedAt,
    updatedAt: identity.observedAt,
    kind: identity.kind,
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
    resolutionStatus: identity.resolutionStatus,
    ...(identity.resolutionErrorCode ? { resolutionErrorCode: identity.resolutionErrorCode } : {}),
    ...(identity.resolutionStatus === 'resolved'
      ? { lastResolvedAt: identity.observedAt }
      : {}),
  };
}

function deduplicateIdentities(observation: ChannelChatObservation): ChannelIdentityObservation[] {
  const result = new Map<string, ChannelIdentityObservation>();
  if (observation.owner) result.set(observation.owner.sourceIdentityId, observation.owner);
  for (const member of observation.members ?? []) result.set(member.identity.sourceIdentityId, member.identity);
  return [...result.values()];
}

function validateObservation(observation: ChannelChatObservation): void {
  if (!observation.sourceChatId || !observation.observedAt) throw new Error('chat observation requires sourceChatId and observedAt');
  if (observation.resolutionStatus === 'resolved' && observation.kind === 'group' && !observation.owner) {
    throw new Error('a resolved group chat observation requires an owner');
  }
}
