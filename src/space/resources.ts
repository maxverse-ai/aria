import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { SpaceAuthorization, type AuthorizedSpaceContext } from './authorization';
import { opaqueId, requiredId } from './identity';

type ResourceKind = 'message' | 'card' | 'attachment' | 'read-resource' | 'progress';
interface ProgressTarget { format: 'cot' | 'card'; messageId: string; cotId?: string; cardId?: string; sequence?: number }
interface Ownership { spaceId: string; bindingRef: string; conversationId: string;
  authorityId?: string; instanceId?: string; scopeRef?: string; progress?: ProgressTarget }
declare const progressOwnerBrand: unique symbol;
export interface ProgressOwner { readonly [progressOwnerBrand]: true }
declare const progressReceiptBrand: unique symbol;
export interface ProgressReceipt extends Readonly<ProgressTarget> {
  readonly [progressReceiptBrand]: true;
}

/** Provider ids alone never confer permission to fetch, update or replay content. */
export class SpaceResourceStore {
  private readonly owners = new Map<string, Ownership>();
  private saving: Promise<void> = Promise.resolve();
  private readonly progressOwners = new WeakMap<ProgressOwner, Ownership>();
  private readonly progressReceipts = new WeakMap<ProgressReceipt, string>();
  constructor(private readonly authorization: SpaceAuthorization, private readonly file?: string) {}
  async load(): Promise<void> {
    if (!this.file) return;
    let data: { schema?: string; owners?: [string, Ownership][] };
    try { data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (data.schema !== 'aria.space.resources.v1' || !Array.isArray(data.owners)) throw new Error('invalid space resource store');
    const loaded = new Map<string, Ownership>();
    for (const [key, owner] of data.owners) {
      if (!/^[a-f0-9]{64}$/.test(key) || !owner.spaceId || !owner.bindingRef || !owner.conversationId || loaded.has(key)) throw new Error('invalid resource ownership');
      if (owner.progress && (!owner.authorityId || !owner.instanceId || !owner.scopeRef
        || !validProgressTarget(owner.progress))) throw new Error('invalid progress ownership');
      loaded.set(key, Object.freeze({ ...owner,
        ...(owner.progress ? { progress: Object.freeze({ ...owner.progress }) } : {}) }));
    }
    for (const [key, owner] of loaded) this.owners.set(key, owner);
  }
  async record(context: AuthorizedSpaceContext, kind: ResourceKind, id: string): Promise<void> {
    const value = this.authorization.inspect(context);
    const key = this.key(context, kind, id);
    const previous = this.owners.get(key);
    // A message/card from a retired epoch cannot be relabelled by a retry.
    if (previous && (previous.bindingRef !== value.binding.ref || previous.spaceId !== value.binding.spaceId)) throw new Error('resource belongs to a retired space binding');
    this.owners.set(key, Object.freeze({ spaceId: value.binding.spaceId, bindingRef: value.binding.ref,
      conversationId: value.binding.conversation.conversationId }));
    if (this.file) {
      const bytes = JSON.stringify({ schema: 'aria.space.resources.v1', owners: [...this.owners] });
      this.saving = this.saving.then(() => writeFileAtomic(this.file!, `${bytes}\n`, { mode: 0o600 }));
      await this.saving;
    }
  }
  owns(context: AuthorizedSpaceContext, kind: ResourceKind, id: string): boolean {
    const value = this.authorization.inspect(context);
    const owner = this.owners.get(this.key(context, kind, id));
    return owner?.spaceId === value.binding.spaceId && owner.bindingRef === value.binding.ref
      && owner.conversationId === value.binding.conversation.conversationId;
  }
  assert(context: AuthorizedSpaceContext, kind: ResourceKind, id: string): void {
    if (!this.owns(context, kind, id)) throw new Error('resource has no matching space binding');
  }
  /** Capture authority before an external create. Its receipt can be retained
   * even if membership changes while that request is in flight. This ticket
   * authorizes recording/terminal cleanup only, never a subsequent send. */
  captureProgressOwner(context: AuthorizedSpaceContext): ProgressOwner {
    const value = this.authorization.inspect(context);
    const ticket = Object.freeze({}) as ProgressOwner;
    this.progressOwners.set(ticket, { spaceId: value.binding.spaceId, bindingRef: value.binding.ref,
      conversationId: value.binding.conversation.conversationId, authorityId: value.principal.authorityId,
      instanceId: value.binding.conversation.instanceId, scopeRef: value.scopeRef });
    return ticket;
  }
  async recordProgress(ticket: ProgressOwner, target: ProgressTarget): Promise<ProgressReceipt> {
    const owner = this.progressOwners.get(ticket);
    if (!owner) throw new Error('untrusted progress owner');
    if (!validProgressTarget(target)) throw new Error('invalid progress target');
    const key = opaqueId('source-resource', [owner.authorityId!, 'progress', target.messageId]);
    const prior = this.owners.get(key);
    if (prior && prior.bindingRef !== owner.bindingRef) throw new Error('progress belongs to another binding');
    this.owners.set(key, Object.freeze({ ...owner, progress: Object.freeze({ ...target }) }));
    await this.persist();
    return this.receipt(key);
  }
  assertProgress(context: AuthorizedSpaceContext, receipt: ProgressReceipt): void {
    const owner = this.progressRecord(receipt);
    const value = this.authorization.inspect(context);
    if (owner.bindingRef !== value.binding.ref || owner.spaceId !== value.binding.spaceId
      || owner.scopeRef !== value.scopeRef
      || owner.conversationId !== value.binding.conversation.conversationId) throw new Error('foreign progress receipt');
  }
  /** Host recovery receives opaque receipts, not arbitrary provider IDs. Only a
   * constant terminal-status payload may use these without the old grant. */
  pendingProgress(authorityId: string, instanceId: string): ProgressReceipt[] {
    return [...this.owners].filter(([, value]) => value.progress && value.authorityId === authorityId && value.instanceId === instanceId)
      .map(([key]) => this.receipt(key));
  }
  async recordIssuedResource(ticket: ProgressOwner, kind: 'message' | 'card', id: string): Promise<void> {
    const owner = this.progressOwners.get(ticket);
    if (!owner) throw new Error('untrusted output owner');
    const key = opaqueId('source-resource', [owner.authorityId!, kind, requiredId(id, 'resource')]);
    const prior = this.owners.get(key);
    if (prior && prior.bindingRef !== owner.bindingRef) throw new Error('resource belongs to a retired binding');
    this.owners.set(key, Object.freeze({ ...owner })); await this.persist();
  }
  assertProgressReceipt(receipt: ProgressReceipt): void { this.progressRecord(receipt); }
  async nextProgressSequence(receipt: ProgressReceipt): Promise<number> {
    const owner = this.progressRecord(receipt);
    const sequence = (owner.progress!.sequence ?? 0) + 1;
    this.owners.set(this.progressReceipts.get(receipt)!, Object.freeze({ ...owner,
      progress: Object.freeze({ ...owner.progress!, sequence }) }));
    await this.persist(); return sequence;
  }
  async finishProgress(receipt: ProgressReceipt): Promise<void> {
    const owner = this.progressRecord(receipt);
    const key = this.progressReceipts.get(receipt)!;
    const { progress: _progress, ...rest } = owner;
    this.owners.set(key, Object.freeze(rest));
    await this.persist();
  }
  private progressRecord(receipt: ProgressReceipt): Ownership {
    const key = this.progressReceipts.get(receipt);
    const owner = key ? this.owners.get(key) : undefined;
    if (!owner?.progress || owner.progress.messageId !== receipt.messageId
      || owner.progress.format !== receipt.format
      || owner.progress.cotId !== receipt.cotId || owner.progress.cardId !== receipt.cardId) throw new Error('invalid or completed progress receipt');
    return owner;
  }
  private receipt(key: string): ProgressReceipt {
    const receipt = Object.freeze({ ...this.owners.get(key)!.progress! }) as ProgressReceipt;
    this.progressReceipts.set(receipt, key); return receipt;
  }
  private async persist(): Promise<void> {
    if (!this.file) return;
    const bytes = JSON.stringify({ schema: 'aria.space.resources.v1', owners: [...this.owners] });
    this.saving = this.saving.then(() => writeFileAtomic(this.file!, `${bytes}\n`, { mode: 0o600 }));
    await this.saving;
  }
  private key(context: AuthorizedSpaceContext, kind: ResourceKind, id: string): string {
    const value = this.authorization.inspect(context);
    return opaqueId('source-resource', [value.principal.authorityId, kind, requiredId(id, 'resource')]);
  }
}

function validProgressTarget(target: ProgressTarget): boolean {
  return typeof target.messageId === 'string' && Boolean(target.messageId.trim())
    && (target.format === 'cot' ? typeof target.cotId === 'string' && Boolean(target.cotId.trim()) && !target.cardId
      : target.format === 'card' && typeof target.cardId === 'string' && Boolean(target.cardId.trim()) && !target.cotId)
    && (target.sequence === undefined || (Number.isSafeInteger(target.sequence) && target.sequence >= 0));
}
