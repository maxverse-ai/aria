import { createHash } from 'node:crypto';
import type {
  MessageResourceEvent,
  MessageResourceSink,
  MessageSessionBinding,
} from '../../runtime/message-resource';
import type { NativeReadRepository } from './native-read-repository';
import type { NativeMessageResource, NativeRunResource, NativeSessionResource } from './native-read-types';
import { nativeReadOpaqueId } from './native-read-identifiers';
import { ChannelIdentityReadProjector } from './channel-identity-read-projector';

interface NativeMessageReadProjectorOptions {
  profileId: string;
  repository: NativeReadRepository;
}

interface ResolvedBinding {
  sessionId: string;
  runId: string;
}

/** Durable message projection with an explicit pending-to-resolved association transition. */
export class NativeMessageReadProjector implements MessageResourceSink {
  private readonly bindings = new Map<string, ResolvedBinding>();
  private readonly identities: ChannelIdentityReadProjector;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: NativeMessageReadProjectorOptions) {
    this.identities = new ChannelIdentityReadProjector(options.profileId, options.repository);
  }

  observe(event: MessageResourceEvent): Promise<void> {
    return this.serialize(async () => {
      const actorKind = event.actorKind ?? (event.direction === 'inbound' ? 'user' : 'bot');
      await this.identities.observeMessage({
        sourceChatId: event.conversationKey,
        ...(event.conversationKind ? { chatKind: event.conversationKind } : {}),
        observedAt: event.occurredAt,
        ...(event.actorSourceId ? {
          actor: { sourceIdentityId: event.actorSourceId, kind: actorKind },
        } : {}),
      });
      const id = messageId(this.options.profileId, event.sourceMessageId);
      const existing = await this.options.repository.get<NativeMessageResource>('message', id);
      const binding = event.correlationId ? this.bindings.get(event.correlationId) : undefined;
      const conversationId = nativeReadOpaqueId('conversation', this.options.profileId, event.conversationKey);
      const sequence = existing?.sequence ?? await this.nextSequence(conversationId);
      const hasText = event.content.text !== undefined;
      const resource: Omit<NativeMessageResource, 'revision'> = {
        resourceType: 'message', id, profileId: this.options.profileId,
        createdAt: existing?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
        conversationId,
        ...(binding ? { sessionId: binding.sessionId, runId: binding.runId } : {}),
        associationStatus: binding ? 'resolved' : 'pending',
        sequence,
        occurredAt: event.occurredAt,
        role: event.direction === 'inbound' ? 'user' : 'assistant',
        direction: event.direction,
        ...(event.actorSourceId ? {
          actorIdentityId: nativeReadOpaqueId('identity', this.options.profileId, event.actorSourceId),
        } : {}),
        content: {
          available: hasText,
          redacted: !hasText,
          format: hasText ? event.content.format : 'unavailable',
          ...(hasText ? { text: event.content.text } : {}),
        },
        attachmentIds: [],
      };
      await this.options.repository.upsert({
        eventId: sourceEventId(this.options.profileId, event.eventId),
        changedAt: event.occurredAt,
        resource,
      });
    });
  }

  bind(binding: MessageSessionBinding): Promise<void> {
    return this.serialize(async () => {
      const sessionId = nativeReadOpaqueId(
        'session', this.options.profileId, binding.agentKind, binding.sourceSessionId,
      );
      const runId = nativeReadOpaqueId('run', this.options.profileId, binding.sourceRunId);
      this.bindings.set(binding.correlationId, { sessionId, runId });
      const conversationId = nativeReadOpaqueId('conversation', this.options.profileId, binding.conversationKey);
      const sourceMessages: Array<{
        sourceMessageId: string;
        resource: NativeMessageResource;
      }> = [];
      for (const sourceMessageId of binding.sourceMessageIds) {
        const id = messageId(this.options.profileId, sourceMessageId);
        const existing = await this.options.repository.get<NativeMessageResource>('message', id);
        if (existing) sourceMessages.push({ sourceMessageId, resource: existing });
      }
      const participantIdentityIds = [...new Set(sourceMessages.flatMap(({ resource }) =>
        resource.actorIdentityId ? [resource.actorIdentityId] : [],
      ))].sort();
      if (binding.conversationKind) {
        await this.identities.observeMessage({
          sourceChatId: binding.conversationKey,
          chatKind: binding.conversationKind,
          observedAt: binding.occurredAt,
        });
      }
      await this.ensureSession(binding, sessionId, participantIdentityIds);
      await this.bindRun(binding, runId, sessionId);
      for (const { sourceMessageId, resource: existing } of sourceMessages) {
        const resource = {
          ...existing,
          updatedAt: binding.occurredAt,
          conversationId,
          sessionId,
          runId,
          associationStatus: 'resolved' as const,
          sequence: existing.conversationId === conversationId
            ? existing.sequence
            : await this.nextSequence(conversationId),
        };
        await this.options.repository.upsert({
          eventId: sourceEventId(this.options.profileId, `${binding.bindingId}:${sourceMessageId}`),
          changedAt: binding.occurredAt,
          resource,
        });
      }
    });
  }

  remove(sourceMessageId: string, occurredAt: string): Promise<void> {
    return this.serialize(async () => {
      await this.options.repository.delete({
        eventId: sourceEventId(this.options.profileId, `removed:${sourceMessageId}`),
        changedAt: occurredAt,
        resourceType: 'message',
        resourceId: messageId(this.options.profileId, sourceMessageId),
      });
    });
  }

  private async ensureSession(
    binding: MessageSessionBinding,
    id: string,
    participantIdentityIds: readonly string[],
  ): Promise<void> {
    const existing = await this.options.repository.get<NativeSessionResource>('session', id);
    const conversationId = nativeReadOpaqueId('conversation', this.options.profileId, binding.conversationKey);
    const mergedParticipantIdentityIds = [...new Set([
      ...(existing?.participantIdentityIds ?? []),
      ...participantIdentityIds,
    ])].sort();
    const bindingShape = JSON.stringify([
      binding.bindingId,
      [...binding.sourceMessageIds].sort(),
      mergedParticipantIdentityIds,
    ]);
    await this.options.repository.upsert({
      eventId: sourceEventId(this.options.profileId, `${bindingShape}:session`),
      changedAt: binding.occurredAt,
      resource: {
        resourceType: 'session', id, profileId: this.options.profileId,
        createdAt: existing?.createdAt ?? binding.occurredAt,
        updatedAt: binding.occurredAt,
        conversationId,
        agentKind: binding.agentKind,
        status: 'active',
        lastActivityAt: binding.occurredAt,
        chatId: nativeReadOpaqueId('chat', this.options.profileId, binding.conversationKey),
        participantIdentityIds: mergedParticipantIdentityIds,
      },
    });
  }

  private async bindRun(binding: MessageSessionBinding, id: string, sessionId: string): Promise<void> {
    const existing = await this.options.repository.get<NativeRunResource>('run', id);
    if (!existing) return;
    await this.options.repository.upsert({
      eventId: sourceEventId(this.options.profileId, `${binding.bindingId}:run`),
      changedAt: binding.occurredAt,
      resource: {
        ...existing,
        updatedAt: binding.occurredAt,
        sessionId,
        associationStatus: 'resolved',
      },
    });
  }

  private async nextSequence(conversationId: string): Promise<number> {
    const messages = await this.options.repository.list<NativeMessageResource>('message');
    return messages.reduce((max, item) => item.conversationId === conversationId ? Math.max(max, item.sequence) : max, 0) + 1;
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function messageId(profileId: string, sourceMessageId: string): string {
  return nativeReadOpaqueId('message', profileId, sourceMessageId);
}

function sourceEventId(profileId: string, source: string): string {
  const digest = createHash('sha256').update(JSON.stringify([1, source])).digest('base64url');
  return nativeReadOpaqueId('source-event', profileId, 'message', digest);
}
