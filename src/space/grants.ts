import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { SpaceAuthorization, type AuthorizedSpaceContext, type AuthorizedSpaceSnapshot } from './authorization';
import { principalId, spaceId, type PrincipalRef } from './identity';
import { readPrivateJson } from './deployment';

interface ExecutionGrantRecord {
  schema: 'aria.space.execution-grant.v1';
  ref: string;
  snapshot: AuthorizedSpaceSnapshot;
  revoked: boolean;
}
/** Durable references for triggers/recovery; ingress never accepts raw snapshots. */
export class ExecutionGrantStore {
  private readonly records = new Map<string, ExecutionGrantRecord>();
  private saving: Promise<void> = Promise.resolve();
  constructor(private readonly authorization: SpaceAuthorization, private readonly file?: string) {}
  async load(): Promise<void> {
    if (!this.file) return;
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const data = raw as { schema?: string; grants?: ExecutionGrantRecord[] };
    if (data.schema !== 'aria.space.execution-grants.v1' || !Array.isArray(data.grants)) throw new Error('invalid execution grant store');
    const loaded = new Map<string, ExecutionGrantRecord>();
    for (const record of data.grants) {
      if (record.schema !== 'aria.space.execution-grant.v1' || !record.ref || !record.snapshot
        || record.ref !== record.snapshot.grantId || loaded.has(record.ref)
        || typeof record.revoked !== 'boolean' || record.snapshot.principal.profileId !== this.authorization.profileId) {
        throw new Error('invalid execution grant');
      }
      loaded.set(record.ref, record);
    }
    for (const record of loaded.values()) {
      this.records.set(record.ref, record);
      if (record.revoked) this.authorization.revoke(record.snapshot.grantId);
    }
  }
  async retain(context: AuthorizedSpaceContext): Promise<string> {
    const snapshot = structuredClone(this.authorization.inspect(context));
    const ref = snapshot.grantId;
    this.records.set(ref, { schema: 'aria.space.execution-grant.v1', ref, snapshot, revoked: false });
    await this.persist(); return ref;
  }
  restore(ref: string, principal: PrincipalRef): AuthorizedSpaceContext {
    const record = this.records.get(ref);
    if (!record || record.revoked || principalId(record.snapshot.principal) !== principalId(principal)) throw new Error('execution grant is unavailable');
    return this.authorization.restore(record.snapshot);
  }
  async revoke(ref: string): Promise<void> {
    const record = this.records.get(ref);
    if (!record) throw new Error('execution grant is unavailable');
    await this.revokeIssued(record.snapshot.grantId);
  }
  /** Persist invalidation when an active operation has already been retained. */
  async revokeIssued(grantId: string): Promise<void> {
    this.authorization.revoke(grantId);
    const record = this.records.get(grantId);
    if (record) {
      this.records.set(grantId, { ...record, revoked: true });
      await this.persist();
    }
  }
  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const data = JSON.stringify({ schema: 'aria.space.execution-grants.v1', grants: [...this.records.values()] });
    this.saving = this.saving.then(() => writeFileAtomic(this.file!, `${data}\n`, { mode: 0o600 }));
    return this.saving;
  }
}

interface AuthorizationTransaction {
  ref: string;
  principalId: string;
  authorityId: string;
  spaceId: string;
  providerId: string;
  expiresAt: number;
  principal: PrincipalRef;
  initiatingGrantId: string;
}
export interface ToolCredentialGrant {
  readonly ref: string;
  readonly spaceId: string;
  readonly principalId: string;
  readonly providerId: string;
  readonly credentialRef: string;
}
/** Credentials stay behind provider adapters; this service owns scope and transaction checks. */
export class SpaceToolIdentity {
  private readonly pending = new Map<string, AuthorizationTransaction>();
  private readonly grants = new Map<string, ToolCredentialGrant>();
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private readonly authorization: SpaceAuthorization, private readonly now = Date.now, private readonly file?: string) {}

  async load(): Promise<void> {
    if (!this.file) return;
    let value: unknown;
    try { value = await readPrivateJson(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const data = value as { schema?: string; profileId?: string; pending?: AuthorizationTransaction[]; grants?: ToolCredentialGrant[] };
    if (!['aria.space.tool-identity.v1', 'aria.space.tool-identity.v2'].includes(data.schema ?? '') || data.profileId !== this.authorization.profileId
      || !Array.isArray(data.pending) || !Array.isArray(data.grants) || data.pending.length > 4096 || data.grants.length > 4096) {
      throw new Error('invalid tool identity store');
    }
    const pending = new Map<string, AuthorizationTransaction>(), grants = new Map<string, ToolCredentialGrant>();
    for (const record of data.pending) {
      if (!record.principal || record.principal.profileId !== data.profileId || record.principal.kind !== 'user'
        || record.principalId !== principalId(record.principal) || record.authorityId !== record.principal.authorityId
        || typeof record.initiatingGrantId !== 'string' || !record.initiatingGrantId
        || !validRecord(record) || !Number.isFinite(record.expiresAt) || pending.has(record.ref)) throw new Error('invalid tool authorization transaction');
      pending.set(record.ref, Object.freeze(structuredClone(record)));
    }
    for (const record of data.grants) {
      if (!validRecord(record) || typeof record.credentialRef !== 'string' || !record.credentialRef || grants.has(record.ref)) {
        throw new Error('invalid tool credential grant');
      }
      // Project only the durable binding fields: legacy grant expiry is not an authorization rule.
      grants.set(record.ref, Object.freeze({ ref: record.ref, spaceId: record.spaceId,
        principalId: record.principalId, providerId: record.providerId, credentialRef: record.credentialRef }));
    }
    if (data.schema === 'aria.space.tool-identity.v1') {
      await writeFileAtomic(this.file, JSON.stringify({ schema: 'aria.space.tool-identity.v2',
        profileId: this.authorization.profileId, pending: [...pending.values()], grants: [...grants.values()] }) + '\n', { mode: 0o600 });
    }
    replace(this.pending, pending); replace(this.grants, grants);
  }

  beginUserAuthorization(context: AuthorizedSpaceContext, providerId: string, expiresAt: number): Promise<string> {
    return this.change(pending => {
      const current = this.privateConversation(context);
      if (!providerId || !Number.isFinite(expiresAt) || expiresAt <= this.now()
        || expiresAt > this.now() + 30 * 60_000) throw new Error('invalid authorization transaction');
      for (const [key, value] of pending) if (value.expiresAt <= this.now()) pending.delete(key);
      if (pending.size >= 4096) throw new Error('tool authorization capacity reached');
      const ref = randomUUID();
      pending.set(ref, { ref, principalId: principalId(current.principal), authorityId: current.principal.authorityId,
        spaceId: current.binding.spaceId, providerId, expiresAt, principal: current.principal, initiatingGrantId: current.grantId });
      return ref;
    });
  }

  transaction(context: AuthorizedSpaceContext, ref: string): Readonly<AuthorizationTransaction> {
    const current = this.privateConversation(context);
    const pending = this.pending.get(ref);
    if (!pending || pending.expiresAt <= this.now() || pending.spaceId !== current.binding.spaceId
      || pending.principalId !== principalId(current.principal)) throw new Error('authorization completion does not match its private transaction');
    return Object.freeze(structuredClone(pending));
  }
  /** Provider adapter must verify its actual account subject before issuing this receipt. */
  completeUserAuthorization(context: AuthorizedSpaceContext, ref: string, receipt: {
    principal: PrincipalRef; providerId: string; credentialRef: string;
  }): Promise<ToolCredentialGrant> {
    return this.change((transactions, grants) => {
      const pending = this.transaction(context, ref);
      if (pending.principalId !== principalId(receipt.principal)
        || pending.authorityId !== receipt.principal.authorityId || pending.providerId !== receipt.providerId
        || !receipt.credentialRef) {
        throw new Error('authorization completion does not match its private transaction');
      }
      for (const [key, value] of grants) {
        if (value.spaceId === pending.spaceId
          && value.principalId === pending.principalId && value.providerId === receipt.providerId) grants.delete(key);
      }
      if (grants.size >= 4096) throw new Error('tool credential capacity reached');
      const grant = Object.freeze({ ref: randomUUID(), spaceId: pending.spaceId, principalId: pending.principalId,
        providerId: receipt.providerId, credentialRef: receipt.credentialRef });
      transactions.delete(ref); grants.set(grant.ref, grant); return grant;
    });
  }
  resolve(context: AuthorizedSpaceContext, ref: string): ToolCredentialGrant {
    const current = this.authorization.inspect(context);
    const grant = this.grants.get(ref);
    if (!grant || current.principal.kind !== 'user' || current.binding.key.kind !== 'user'
      || grant.spaceId !== personalCredentialSpace(current) || grant.principalId !== principalId(current.principal)) {
      throw new Error('tool credential grant is unavailable');
    }
    return grant;
  }
  find(context: AuthorizedSpaceContext, providerId: string): ToolCredentialGrant | undefined {
    const current = this.authorization.inspect(context);
    if (current.principal.kind !== 'user' || current.binding.key.kind !== 'user') return undefined;
    const matches = [...this.grants.values()].filter(grant => grant.spaceId === personalCredentialSpace(current)
      && grant.principalId === principalId(current.principal) && grant.providerId === providerId);
    if (matches.length > 1) throw new Error('ambiguous tool credential grant');
    return matches[0] ? this.resolve(context, matches[0].ref) : undefined;
  }
  revoke(ref: string): Promise<void> { return this.change((_pending, grants) => { grants.delete(ref); }); }
  cancel(ref: string): Promise<void> { return this.change(pending => { pending.delete(ref); }); }
  private privateConversation(context: AuthorizedSpaceContext): AuthorizedSpaceSnapshot {
    const current = this.authorization.inspect(context);
    if (current.binding.key.kind !== 'user' || current.principal.kind !== 'user' || current.sourceKind !== 'direct') {
      throw new Error('user authorization requires a verified direct conversation');
    }
    return current;
  }
  private change<T>(update: (pending: Map<string, AuthorizationTransaction>, grants: Map<string, ToolCredentialGrant>) => T): Promise<T> {
    const work = this.writing.then(async () => {
      const pending = new Map(this.pending), grants = new Map(this.grants);
      const result = update(pending, grants);
      if (this.file) await writeFileAtomic(this.file, JSON.stringify({ schema: 'aria.space.tool-identity.v2',
        profileId: this.authorization.profileId, pending: [...pending.values()], grants: [...grants.values()] }) + '\n', { mode: 0o600 });
      replace(this.pending, pending); replace(this.grants, grants);
      return result;
    });
    this.writing = work.catch(() => undefined);
    return work;
  }
}

function validRecord(record: { ref: string; spaceId: string; principalId: string; providerId: string }): boolean {
  return typeof record.ref === 'string' && !!record.ref && /^[a-f0-9]{64}$/.test(record.spaceId)
    && /^[a-f0-9]{64}$/.test(record.principalId) && typeof record.providerId === 'string' && !!record.providerId;
}
function replace<T>(target: Map<string, T>, source: Map<string, T>): void {
  target.clear(); for (const [key, value] of source) target.set(key, value);
}

/** OAuth remains anchored to the user's private Space, independent of the current work Space. */
function personalCredentialSpace(current: AuthorizedSpaceSnapshot): string {
  return spaceId({ kind: 'user', profileId: current.principal.profileId, principal: current.principal });
}
