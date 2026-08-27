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

/** Converts channel-owned identifiers and names into opaque native-read resources. */
export class ChannelIdentityReadProjector {
  constructor(
    private readonly profileId: string,
    private readonly repository: NativeReadRepository,
  ) {}

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
    lastResolvedAt: identity.observedAt,
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
