import { createHash, randomUUID } from 'node:crypto';
import type { ControlActorContext } from '../../application/control';
import type { TriggerDefinitionReadModel, TriggerManagementApi, TriggerReadSnapshot } from '../operations';
import type { ConversationAnchorStore } from './anchor-store';

export interface ConversationReminderCreateInput {
  profileId: string;
  endpoint: { pluginId: string; instanceId: string; scopeId: string; sourceMessageId?: string };
  at: string;
  timeZone?: string;
  prompt: string;
  label?: string;
}

export interface ConversationReminderControl {
  create(input: Omit<ConversationReminderCreateInput, 'profileId' | 'endpoint'> & {
    scopeId: string;
    sourceMessageId?: string;
  }, actor: ControlActorContext): Promise<TriggerDefinitionReadModel>;
  list(actor: ControlActorContext): Promise<readonly TriggerDefinitionReadModel[]>;
  snooze(definitionId: string, at: string, actor: ControlActorContext): Promise<TriggerDefinitionReadModel>;
  update(definitionId: string, prompt: string, actor: ControlActorContext): Promise<TriggerDefinitionReadModel>;
  cancel(definitionId: string, actor: ControlActorContext): Promise<TriggerDefinitionReadModel>;
  history(definitionId: string, actor: ControlActorContext): Promise<TriggerReadSnapshot>;
}

export interface ConversationReminderServiceOptions {
  api: TriggerManagementApi;
  anchors: ConversationAnchorStore;
  now?: () => number;
  createId?: () => string;
  authorize?: (actor: ControlActorContext, profileId: string) => boolean | Promise<boolean>;
}

export class ConversationReminderService {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: ConversationReminderServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  async create(input: ConversationReminderCreateInput, actor: ControlActorContext): Promise<TriggerDefinitionReadModel> {
    await this.authorize(actor, input.profileId);
    const now = this.now();
    const at = futureDateTime(input.at, now);
    const anchorId = this.createId();
    await this.options.anchors.create({
      schemaVersion: 1, id: anchorId, profileId: input.profileId,
      pluginId: required(input.endpoint.pluginId, 'pluginId'),
      instanceId: required(input.endpoint.instanceId, 'instanceId'),
      scopeId: required(input.endpoint.scopeId, 'scopeId'),
      ...(input.endpoint.sourceMessageId ? { sourceMessageId: input.endpoint.sourceMessageId } : {}),
      ownerFingerprint: actorFingerprint(actor), createdAt: now, updatedAt: now,
    });
    try {
      const result = await this.execute('create', {
        profileId: input.profileId,
        ownerRef: actor.principal,
        createdBy: 'user',
        label: input.label ?? 'Conversation reminder',
        schedule: { kind: 'once', at },
        timeZone: input.timeZone ?? 'UTC',
        prompt: required(input.prompt, 'prompt'),
        conversationRef: anchorId,
      }, actor);
      const definition = requireDefinition(result.definition);
      await this.options.anchors.bind(anchorId, definition.id, this.now());
      return definition;
    } catch (error) {
      await this.options.anchors.delete(anchorId).catch(() => undefined);
      throw error;
    }
  }

  async list(profileId: string, actor: ControlActorContext): Promise<readonly TriggerDefinitionReadModel[]> {
    await this.authorize(actor, profileId);
    const anchors = await this.options.anchors.list({ profileId, ownerFingerprint: actorFingerprint(actor) });
    const definitions = await Promise.all(anchors.flatMap((anchor) => anchor.definitionId
      ? [this.options.api.read({ definitionId: anchor.definitionId }).then((value) => value.definitions[0])]
      : []));
    return definitions.filter((value): value is TriggerDefinitionReadModel => value !== undefined);
  }

  async snooze(profileId: string, definitionId: string, at: string, actor: ControlActorContext): Promise<TriggerDefinitionReadModel> {
    await this.requireOwned(profileId, definitionId, actor);
    return requireDefinition((await this.execute('update', {
      definitionId, schedule: { kind: 'once', at: futureDateTime(at, this.now()) },
    }, actor)).definition);
  }

  async update(profileId: string, definitionId: string, prompt: string, actor: ControlActorContext): Promise<TriggerDefinitionReadModel> {
    await this.requireOwned(profileId, definitionId, actor);
    return requireDefinition((await this.execute('update', {
      definitionId, prompt: required(prompt, 'prompt'),
    }, actor)).definition);
  }

  async cancel(profileId: string, definitionId: string, actor: ControlActorContext): Promise<TriggerDefinitionReadModel> {
    await this.requireOwned(profileId, definitionId, actor);
    return requireDefinition((await this.execute('cancel', { definitionId }, actor)).definition);
  }

  async history(profileId: string, definitionId: string, actor: ControlActorContext): Promise<TriggerReadSnapshot> {
    await this.requireOwned(profileId, definitionId, actor);
    return this.options.api.read({ definitionId });
  }

  private async requireOwned(profileId: string, definitionId: string, actor: ControlActorContext): Promise<void> {
    await this.authorize(actor, profileId);
    const anchors = await this.options.anchors.list({ profileId, ownerFingerprint: actorFingerprint(actor) });
    const anchor = anchors.find((item) => item.definitionId === definitionId);
    if (!anchor) throw Object.assign(new Error('reminder not found or not owned by actor'), { code: 'reminder-forbidden' });
  }

  private async authorize(actor: ControlActorContext, profileId: string): Promise<void> {
    if (!profileId.trim() || actor.source === 'agent' || !actor.principal.trim()
      || (this.options.authorize && !await this.options.authorize(actor, profileId))) {
      throw Object.assign(new Error('conversation reminder is not authorized'), { code: 'reminder-forbidden' });
    }
  }

  private execute(command: 'create' | 'update' | 'cancel', input: Record<string, unknown>, actor: ControlActorContext) {
    return this.options.api.execute({
      schema: 'aria.trigger-management.execute.request.v1', apiVersion: 1,
      requestId: this.createId(), actor, command, input,
    });
  }
}

function futureDateTime(value: string, now: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw Object.assign(new Error('invalid reminder date-time'), { code: 'invalid-reminder-time' });
  if (timestamp <= now) throw Object.assign(new Error('reminder date-time must be in the future'), { code: 'invalid-reminder-time' });
  return new Date(timestamp).toISOString();
}
function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 16_384) throw Object.assign(new Error(`${name} is required`), { code: 'invalid-reminder' });
  return normalized;
}
function actorFingerprint(actor: ControlActorContext): string {
  return `sha256:${createHash('sha256').update(`${actor.source}\0${actor.principal}`).digest('hex')}`;
}
function requireDefinition(value: TriggerDefinitionReadModel | undefined): TriggerDefinitionReadModel {
  if (!value) throw new Error('trigger management result did not include a definition');
  return value;
}
