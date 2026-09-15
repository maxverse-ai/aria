import { createHash, randomBytes } from 'node:crypto';
import { writeFileAtomic } from '../platform/atomic-write';
import type { NativeReadRepository } from '../application/control/native-read-repository';
import { readPrivateJson } from './deployment';
import type { ExecutionSpaceServices } from './services';
import type { SpaceNativeRead } from './native-read';
import type { SpaceOperation, SpaceOperationCheckpoint, SpaceOperationGate } from './operation-gate';

interface ReadAccessRecord {
  digest: string;
  instanceId: string;
  checkpoint: SpaceOperationCheckpoint;
  expiresAt: number;
}

/** The controller delegates a previously authenticated source operation. A
 * transport token or caller-supplied user/space id cannot create that operation.
 * Persist hashes only; the returned capability is never written to the journal. */
export class SpaceReadAccess {
  private readonly records = new Map<string, ReadAccessRecord>();
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(private readonly input: {
    services: ExecutionSpaceServices;
    reads: SpaceNativeRead;
    file: string;
    gate: (instanceId: string) => SpaceOperationGate;
    now?: () => number;
  }) {}

  /** Offline management invalidates capabilities at a mode boundary. Source
   * bindings and tool grants stay retained; old read tickets cannot revive. */
  static async invalidateRetained(file: string): Promise<void> {
    await writeFileAtomic(file, JSON.stringify({ schema: 'aria.space.read-access.v1', records: [] }) + '\n', { mode: 0o600 });
  }

  async load(): Promise<void> {
    let value: unknown;
    try { value = await readPrivateJson(this.input.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const data = value as { schema?: string; records?: ReadAccessRecord[] };
    if (data.schema !== 'aria.space.read-access.v1' || !Array.isArray(data.records) || data.records.length > 4096) {
      throw new Error('invalid space read access store');
    }
    const loaded = new Map<string, ReadAccessRecord>();
    for (const record of data.records) {
      if (!/^[a-f0-9]{64}$/.test(record.digest) || loaded.has(record.digest)
        || typeof record.instanceId !== 'string' || !record.instanceId
        || !Number.isFinite(record.expiresAt) || record.checkpoint?.schema !== 'aria.space.operation.v1'
        || record.checkpoint.principal?.profileId !== this.input.services.authorization.profileId) {
        throw new Error('invalid space read access record');
      }
      loaded.set(record.digest, structuredClone(record));
    }
    this.records.clear();
    for (const [key, record] of loaded) this.records.set(key, record);
  }

  async issueFromDirect(gate: SpaceOperationGate, operation: SpaceOperation, targetConversationId?: string) {
    if (operation.request.kind !== 'direct' || operation.request.senderKind !== 'user') throw new Error('read delegation must be requested in a real private conversation');
    await gate.refresh(operation);
    if (targetConversationId !== undefined) {
      if (!targetConversationId || targetConversationId.length > 256 || /\s/.test(targetConversationId)) throw new Error('invalid read conversation target');
      // The source adapter verifies the same sender's membership and admission.
      // A target ID selects a conversation; it cannot grant authority to it.
      const target = await gate.enter({ conversationId: targetConversationId, kind: 'group',
        senderId: operation.request.senderId, senderKind: 'user' }, targetConversationId);
      return this.issue(gate, target);
    }
    return this.issue(gate, operation);
  }

  async issue(gate: SpaceOperationGate, operation: SpaceOperation, ttlMs = 15 * 60_000) {
    if (gate.services !== this.input.services || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60_000) {
      throw new Error('invalid space read delegation');
    }
    const checkpoint = await gate.checkpoint(operation);
    const snapshot = this.input.services.authorization.inspect(operation.context);
    const token = randomBytes(32).toString('hex');
    const record: ReadAccessRecord = { digest: hash(token), checkpoint,
      instanceId: snapshot.binding.conversation.instanceId,
      expiresAt: Math.min(this.now() + ttlMs, snapshot.expiresAt) };
    if (this.input.gate(record.instanceId) !== gate) throw new Error('read source is not registered');
    await this.change(next => {
      for (const [key, item] of next) if (item.expiresAt <= this.now()) next.delete(key);
      if (next.size >= 4096) throw new Error('space read access capacity reached');
      next.set(record.digest, record);
    });
    return { token, expiresAt: record.expiresAt, spaceId: snapshot.binding.spaceId };
  }

  /** Management may revoke by the opaque token; native agents have no endpoint
   * that accepts a different user's token or grants management authority. */
  async revoke(token: string): Promise<void> {
    const digest = tokenDigest(token);
    await this.change(next => { next.delete(digest); });
  }

  async repository(token: string): Promise<NativeReadRepository> {
    const digest = tokenDigest(token);
    const record = this.current(digest);
    const gate = this.input.gate(record.instanceId);
    const operation = await gate.restore(record.checkpoint);
    this.current(digest);
    const repository = await this.input.reads.repository(operation.context);
    const guarded = async <T>(read: () => Promise<T>): Promise<T> => {
      this.current(digest);
      await gate.refresh(operation);
      const result = await read();
      this.current(digest);
      await gate.refresh(operation);
      return result;
    };
    // The returned object is issued by SpaceNativeRead as well, so HTTP hosts
    // keep their existing rejection of ambient/foreign repositories.
    return this.input.reads.guardRepository(repository, {
      initialize: () => guarded(() => repository.initialize()),
      get: (type, id) => guarded(() => repository.get(type, id)),
      list: type => guarded(() => repository.list(type)),
      currentCursor: () => guarded(() => repository.currentCursor()),
      changes: (after, limit) => guarded(() => repository.changes(after, limit)),
      upsert: async () => { throw new Error('space read access cannot write'); },
      delete: async () => { throw new Error('space read access cannot write'); },
    });
  }

  private now(): number { return (this.input.now ?? Date.now)(); }
  private current(digest: string): ReadAccessRecord {
    const record = this.records.get(digest);
    if (!record || record.expiresAt <= this.now()) throw new Error('space read access expired or revoked');
    return record;
  }
  private change(update: (next: Map<string, ReadAccessRecord>) => void): Promise<void> {
    const operation = this.mutation.then(async () => {
      const next = new Map(this.records);
      update(next);
      await writeFileAtomic(this.input.file, JSON.stringify({ schema: 'aria.space.read-access.v1', records: [...next.values()] }) + '\n', { mode: 0o600 });
      this.records.clear();
      for (const [key, record] of next) this.records.set(key, record);
    });
    this.mutation = operation.catch(() => undefined);
    return operation;
  }
}

function hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function tokenDigest(token: string): string {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid space read access token');
  return hash(token);
}
