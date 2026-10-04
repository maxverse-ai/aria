import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileNativeReadRepository } from '../../../src/platform/file-native-read-repository';
import type { NativeIdentityResource } from '../../../src/application/control/native-read-types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileNativeReadRepository', () => {
  it('persists an isolated profile read model without touching native stores', async () => {
    const root = await tempRoot();
    const nativeStore = join(root, 'codex-native.jsonl');
    await writeFile(nativeStore, 'native-session-data\n');
    const repository = createRepository(root, 'demo');

    await repository.upsert({ eventId: 'event-1', resource: identity('demo', 'user-1', 'Ada') });

    expect(await repository.get<NativeIdentityResource>('identity', 'user-1')).toMatchObject({
      displayName: 'Ada',
      revision: 1,
    });
    expect(await readFile(nativeStore, 'utf8')).toBe('native-session-data\n');
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'native-read', 'snapshot.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, 'native-read', 'changes.jsonl'))).mode & 0o777).toBe(0o600);
    }
  });

  it('assigns monotonic revisions and makes event retries idempotent', async () => {
    const root = await tempRoot();
    const repository = createRepository(root, 'demo');

    const first = await repository.upsert({
      eventId: 'event-1',
      resource: identity('demo', 'user-1', 'Ada'),
    });
    const retried = await repository.upsert({
      eventId: 'event-1',
      resource: identity('demo', 'user-1', 'Ignored retry'),
    });
    const second = await repository.upsert({
      eventId: 'event-2',
      resource: identity('demo', 'user-1', 'Ada Lovelace'),
    });

    expect(retried).toEqual(first);
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect((await repository.changes(null)).changes).toHaveLength(2);
    expect((await repository.get<NativeIdentityResource>('identity', 'user-1'))?.displayName).toBe('Ada Lovelace');
  });

  it('serializes concurrent writes into one contiguous journal', async () => {
    const root = await tempRoot();
    const repository = createRepository(root, 'demo');

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.upsert({
          eventId: `event-${index}`,
          resource: identity('demo', `user-${index}`, `User ${index}`),
        }),
      ),
    );

    const restarted = createRepository(root, 'demo');
    const changes = (await restarted.changes(null, 100)).changes;
    expect(changes).toHaveLength(20);
    expect(new Set(changes.map((change) => change.cursor)).size).toBe(20);
    expect(await restarted.list('identity')).toHaveLength(20);
  });

  it('pages changes with profile-bound cursors', async () => {
    const root = await tempRoot();
    const demo = createRepository(root, 'demo');
    const jack = createRepository(join(root, 'jack'), 'jack');
    await demo.upsert({ eventId: 'event-1', resource: identity('demo', 'user-1', 'Ada') });
    await demo.upsert({ eventId: 'event-2', resource: identity('demo', 'user-2', 'Grace') });

    const firstPage = await demo.changes(null, 1);
    const secondPage = await demo.changes(firstPage.nextCursor, 1);

    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.changes.map((change) => change.eventId)).toEqual(['event-1']);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.changes.map((change) => change.eventId)).toEqual(['event-2']);
    await expect(jack.changes(firstPage.nextCursor)).rejects.toMatchObject({
      code: 'PROFILE_MISMATCH',
    });
  });

  it('persists delete tombstones in the journal and restores state after restart', async () => {
    const root = await tempRoot();
    const first = createRepository(root, 'demo');
    await first.upsert({ eventId: 'event-1', resource: identity('demo', 'user-1', 'Ada') });
    const deletion = await first.delete({
      eventId: 'event-2',
      resourceType: 'identity',
      resourceId: 'user-1',
    });

    const restarted = createRepository(root, 'demo');
    expect(await restarted.get('identity', 'user-1')).toBeUndefined();
    expect(deletion).toMatchObject({ operation: 'delete', revision: 2, resourceId: 'user-1' });
    expect((await restarted.changes(null)).changes.map((change) => change.operation)).toEqual([
      'upsert',
      'delete',
    ]);

    const reappeared = await restarted.upsert({
      eventId: 'event-3',
      resource: identity('demo', 'user-1', 'Ada again'),
    });
    expect(reappeared.revision).toBe(3);
  });

  it('rebuilds a corrupt snapshot from the authoritative journal', async () => {
    const root = await tempRoot();
    const first = createRepository(root, 'demo');
    await first.upsert({ eventId: 'event-1', resource: identity('demo', 'user-1', 'Ada') });
    await writeFile(join(root, 'native-read', 'snapshot.json'), '{broken');

    const restarted = createRepository(root, 'demo');

    expect(await restarted.get<NativeIdentityResource>('identity', 'user-1')).toMatchObject({
      displayName: 'Ada',
      revision: 1,
    });
  });

  it('ignores only a torn trailing journal write', async () => {
    const root = await tempRoot();
    const first = createRepository(root, 'demo');
    await first.upsert({ eventId: 'event-1', resource: identity('demo', 'user-1', 'Ada') });
    const journal = join(root, 'native-read', 'changes.jsonl');
    await writeFile(journal, `${await readFile(journal, 'utf8')}{"schema":`);

    const restarted = createRepository(root, 'demo');

    expect(await restarted.list('identity')).toHaveLength(1);
    expect((await restarted.changes(null)).changes).toHaveLength(1);

    await restarted.upsert({ eventId: 'event-2', resource: identity('demo', 'user-2', 'Grace') });
    const restartedAgain = createRepository(root, 'demo');
    expect(await restartedAgain.list('identity')).toHaveLength(2);
    expect((await restartedAgain.changes(null)).changes).toHaveLength(2);
  });

  it('returns detached values so callers cannot mutate persisted state', async () => {
    const root = await tempRoot();
    const repository = createRepository(root, 'demo');
    const draft = identity('demo', 'user-1', 'Ada');
    const writeResult = await repository.upsert({ eventId: 'event-1', resource: draft });

    draft.displayName = 'mutated input';
    if (writeResult.resource?.resourceType === 'identity') {
      writeResult.resource.displayName = 'mutated write result';
    }
    const returned = await repository.get<NativeIdentityResource>('identity', 'user-1');
    if (returned) returned.displayName = 'mutated output';

    expect((await repository.get<NativeIdentityResource>('identity', 'user-1'))?.displayName).toBe('Ada');
  });

  it('does not trust a snapshot when its authoritative journal is missing', async () => {
    const root = await tempRoot();
    const repository = createRepository(root, 'demo');
    await repository.upsert({ eventId: 'event-1', resource: identity('demo', 'user-1', 'Ada') });
    await rm(join(root, 'native-read', 'changes.jsonl'));

    const restarted = createRepository(root, 'demo');

    expect(await restarted.list('identity')).toEqual([]);
    expect((await restarted.changes(null)).changes).toEqual([]);
  });

  it('rejects resources belonging to another profile', async () => {
    const root = await tempRoot();
    const repository = createRepository(root, 'demo');

    await expect(
      repository.upsert({ eventId: 'event-1', resource: identity('jack', 'user-1', 'Ada') }),
    ).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' });
  });
});

function createRepository(root: string, profileId: string): FileNativeReadRepository {
  return new FileNativeReadRepository({
    profileId,
    snapshotFile: join(root, 'native-read', 'snapshot.json'),
    journalFile: join(root, 'native-read', 'changes.jsonl'),
    now: () => '2026-08-27T00:00:00.000Z',
  });
}

function identity(profileId: string, id: string, displayName: string): Omit<NativeIdentityResource, 'revision'> {
  return {
    resourceType: 'identity',
    id,
    profileId,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    kind: 'user',
    displayName,
    resolutionStatus: 'resolved',
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aria-native-read-'));
  roots.push(root);
  return root;
}
