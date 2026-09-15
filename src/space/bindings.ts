import { readFile } from 'node:fs/promises';
import { immutable } from './immutable';
import { writeFileAtomic } from '../platform/atomic-write';
import { conversationId, opaqueId, spaceId, type AudienceObservation, type ConversationRef, type SpaceKey } from './identity';

export interface SpaceBinding {
  readonly schema: 'aria.space.binding.v1';
  readonly ref: string;
  readonly conversation: ConversationRef;
  readonly spaceId: string;
  readonly key: SpaceKey;
  readonly version: number;
  readonly audienceKey: string;
  readonly revision: number;
  readonly expiresAt: number;
  readonly private: boolean;
  readonly state: 'active' | 'suspended';
}

/** Host-only metadata. Old binding versions are never reactivated. */
export class SpaceBindingStore {
  private readonly bindings = new Map<string, SpaceBinding>();
  private saving: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(binding: SpaceBinding) => void>();
  constructor(private readonly file?: string) {}

  async load(): Promise<void> {
    if (!this.file) return;
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const data = raw as { schema?: string; bindings?: SpaceBinding[] };
    if (data.schema !== 'aria.space.bindings.v1' || !Array.isArray(data.bindings)) throw new Error('unsupported space binding store');
    const loaded = new Map<string, SpaceBinding>();
    for (const binding of data.bindings) {
      if (binding.schema !== 'aria.space.binding.v1' || binding.spaceId !== spaceId(binding.key)
        || binding.key.profileId !== binding.conversation.profileId
        || !Number.isSafeInteger(binding.version) || binding.version < 1 || !Number.isSafeInteger(binding.revision) || binding.revision < 0
        || typeof binding.private !== 'boolean' || typeof binding.audienceKey !== 'string' || !binding.audienceKey
        || !['active', 'suspended'].includes(binding.state)
        || binding.ref !== opaqueId('binding', [conversationId(binding.conversation), binding.version])) {
        throw new Error('invalid persisted space binding');
      }
      // Membership must be observed anew after a host restart. Reopening a private
      // epoch without fresh evidence could release a queued answer to new members.
      const id = conversationId(binding.conversation);
      if (loaded.has(id)) throw new Error('duplicate persisted space binding');
      loaded.set(id, immutable({ ...binding, expiresAt: 0 }));
    }
    this.bindings.clear();
    for (const [id, binding] of loaded) this.bindings.set(id, binding);
  }

  current(conversation: ConversationRef): SpaceBinding | undefined {
    return this.bindings.get(conversationId(conversation));
  }

  /** Host diagnostics only; keys are not fresh audience authorizations. */
  spaceKeys(): readonly SpaceKey[] {
    return [...new Map([...this.bindings.values()].map(b => [b.spaceId, b.key])).values()];
  }

  bind(observation: AudienceObservation, decision: { key: SpaceKey; audienceKey: string; private: boolean }): SpaceBinding {
    const id = conversationId(observation.conversation);
    const prior = this.bindings.get(id);
    if (prior && observation.revision < prior.revision) throw new Error('stale audience observation');
    const nextSpace = spaceId(decision.key);
    const same = prior?.state === 'active' && prior.spaceId === nextSpace && prior.audienceKey === decision.audienceKey;
    if (prior && observation.revision === prior.revision && !same) throw new Error('contradictory audience revision');
    const version = same ? prior.version : (prior?.version ?? 0) + 1;
    const binding: SpaceBinding = immutable({
      schema: 'aria.space.binding.v1', ref: opaqueId('binding', [id, version]),
      conversation: Object.freeze({ ...observation.conversation }), spaceId: nextSpace,
      key: JSON.parse(JSON.stringify(decision.key)) as SpaceKey,
      version, audienceKey: decision.audienceKey, revision: observation.revision,
      expiresAt: observation.expiresAt, private: decision.private, state: 'active',
    });
    this.bindings.set(id, binding);
    this.persist();
    if (prior && !same) for (const listener of this.listeners) listener(prior);
    return binding;
  }

  suspend(conversation: ConversationRef, revision?: number): void {
    const prior = this.current(conversation);
    if (!prior || (revision !== undefined && revision < prior.revision)) return;
    this.bindings.set(conversationId(conversation), Object.freeze({
      ...prior, state: 'suspended', revision: Math.max(revision ?? prior.revision, prior.revision), expiresAt: 0,
    }));
    this.persist();
    for (const listener of this.listeners) listener(prior);
  }

  assertCurrent(binding: SpaceBinding, now: number): void {
    const current = this.current(binding.conversation);
    if (!current || current.state !== 'active' || current.ref !== binding.ref || current.spaceId !== binding.spaceId
      || current.version !== binding.version || current.expiresAt <= now) throw new Error('space binding is stale or suspended');
  }
  onInvalidated(listener: (binding: SpaceBinding) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  async flush(): Promise<void> { await this.saving; }
  private persist(): void {
    if (!this.file) return;
    const data = JSON.stringify({ schema: 'aria.space.bindings.v1', bindings: [...this.bindings.values()] });
    // A persistence failure stays observable; callers must flush before accepting work.
    this.saving = this.saving.then(() => writeFileAtomic(this.file!, `${data}\n`, { mode: 0o600 }));
    void this.saving.catch(() => undefined);
  }
}
