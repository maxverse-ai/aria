import { join } from 'node:path';
import { FileNativeReadRepository } from '../platform/file-native-read-repository';
import { SessionCatalogReadProjector } from '../application/control/session-catalog-read-projector';
import { NativeReadRepositoryError, type NativeReadRepository } from '../application/control/native-read-repository';
import type { NativeReadChange, NativeReadCursor } from '../application/control/native-read-types';
import { ExecutionSpaceServices } from './services';
import type { AuthorizedSpaceContext } from './authorization';
import { opaqueId } from './identity';
import { observeNativeRepository } from '../application/control/management-read-model';

/** Physical space partition plus per-call authorization, including cursor/list reads. */
export class SpaceNativeRead {
  private readonly repositories = new Map<string, Promise<NativeReadRepository>>();
  private readonly issued = new WeakMap<NativeReadRepository, AuthorizedSpaceContext>();
  private readonly observers = new Set<(partition: string, change: NativeReadChange) => Promise<void>>();
  constructor(private readonly services: ExecutionSpaceServices) {}
  /** Host composition only. Never exposed through a Space tool or delegated repository. */
  observeCommitted(listener: (partition: string, change: NativeReadChange) => Promise<void>): () => void {
    this.observers.add(listener); return () => { this.observers.delete(listener); };
  }
  assertRepository(repository: NativeReadRepository): void {
    const context = this.issued.get(repository);
    if (!context) throw new Error('native read repository has no space authority');
    this.services.authorization.inspect(context);
  }
  /** Trusted composition can narrow an issued view, never issue authority for
   * a foreign repository. The wrapper retains that view's original context. */
  guardRepository(repository: NativeReadRepository, operations: Omit<NativeReadRepository, 'profileId'>): NativeReadRepository {
    this.assertRepository(repository);
    const guarded = Object.freeze({ profileId: repository.profileId, ...operations });
    this.issued.set(guarded, this.issued.get(repository)!);
    return guarded;
  }
  async repository(context: AuthorizedSpaceContext): Promise<NativeReadRepository> {
    const snapshot = this.services.authorization.inspect(context);
    const state = await this.services.state.view(context);
    const shared = snapshot.binding.key.kind === 'shared';
    const partition = shared ? opaqueId('read-audience', [snapshot.binding.ref, snapshot.scopeRef]) : snapshot.binding.spaceId;
    const directory = shared ? join(state.paths.control, 'read-audiences', partition) : state.paths.control;
    let loading = this.repositories.get(partition);
    if (!loading) {
      loading = (async () => {
        const repository = new FileNativeReadRepository({ profileId: snapshot.principal.profileId,
          snapshotFile: join(directory, 'native-read.snapshot.json'),
          journalFile: join(directory, 'native-read.journal.jsonl') });
        await repository.initialize();
        return observeNativeRepository(repository, async change => {
          for (const observer of this.observers) await observer(partition, change);
        });
      })().catch((error) => { this.repositories.delete(partition); throw error; });
      this.repositories.set(partition, loading);
    }
    const repository = await loading;
    this.services.authorization.inspect(context);
    const projector = new SessionCatalogReadProjector({ profileId: snapshot.principal.profileId, repository });
    await projector.project({ entries: state.sessionCatalog.entries().filter(entry => !shared || entry.scopeId === snapshot.executionScope) });
    this.services.authorization.inspect(context);
    // The underlying journal cursor is profile-local. Fence the public cursor by
    // its original space AND audience epoch, including after a host restart.
    const prefix = `snr2.${partition}.${Buffer.from(snapshot.binding.ref).toString('base64url')}.`;
    const encode = (cursor: NativeReadCursor) => prefix + cursor;
    const decode = (cursor: NativeReadCursor | null) => {
      if (cursor === null) return null;
      if (!cursor.startsWith(prefix)) throw new NativeReadRepositoryError('CURSOR_INVALID', 'cursor belongs to another space binding');
      return cursor.slice(prefix.length);
    };
    const change = (value: NativeReadChange): NativeReadChange => ({ ...value, cursor: encode(value.cursor) });
    const guarded = async <T>(read: () => Promise<T>): Promise<T> => {
      this.services.authorization.inspect(context);
      const result = await read();
      this.services.authorization.inspect(context);
      return result;
    };
    const view = Object.freeze({
      profileId: repository.profileId,
      initialize: () => guarded(() => repository.initialize()),
      currentCursor: () => guarded(async () => encode(await repository.currentCursor())),
      get: (type, id) => guarded(() => repository.get(type, id)),
      list: (type) => guarded(() => repository.list(type)),
      upsert: (input) => guarded(async () => change(await repository.upsert(input))),
      delete: (input) => guarded(async () => change(await repository.delete(input))),
      changes: (after, limit) => guarded(async () => {
        const page = await repository.changes(decode(after), limit);
        return { ...page, after, nextCursor: encode(page.nextCursor), changes: page.changes.map(change) };
      }),
    } satisfies NativeReadRepository);
    this.issued.set(view, context);
    return view;
  }
}
