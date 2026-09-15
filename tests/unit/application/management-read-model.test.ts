import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileNativeReadRepository } from '../../../src/platform/file-native-read-repository';
import { ManagementReadModel, snapshotChange } from '../../../src/application/control/management-read-model';
import type { NativeSessionResource } from '../../../src/application/control/native-read-types';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'aria-admin-read-')); roots.push(root);
 const options = { profileId: 'p', snapshotFile: join(root, 'snapshot.json'), journalFile: join(root, 'journal.jsonl') };
 return { options, repository: new FileNativeReadRepository(options) };
}
function session(id: string, n: number): NativeSessionResource {
 const time = `2026-09-08T08:00:0${n}.000Z`;
 return { resourceType: 'session', id, profileId: 'p', revision: 1, conversationId: 'chat', agentKind: 'codex',
  status: 'active', createdAt: time, updatedAt: time, lastActivityAt: time, participantIdentityIds: [] };
}
it('cursor pages remain immutable while new activity arrives; provenance and identical source IDs stay separate', async () => {
 const f = await fixture(); let now = 0; const model = new ManagementReadModel(f.repository, () => now);
 await model.accept('a', snapshotChange(session('same', 1))); await model.accept('b', snapshotChange(session('same', 2)));
 const first = await model.page(1); expect(first.total).toBe(2);
 const newValue = session('same', 3); newValue.revision = 2;
 await model.accept('a', snapshotChange(newValue));
 const second = await model.page(1, first.nextCursor);
 expect(second.items[0]!.session.id).not.toBe(first.items[0]!.session.id);
 expect(second.items[0]!.session.lastActivityAt).toContain('01.000Z');
 expect((await model.page(1)).items[0]!.session.lastActivityAt).toContain('03.000Z');
 now = 60_001; await expect(model.page(1, first.nextCursor)).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
});
it('read-only bootstrap never repairs a source journal or snapshot', async () => {
 const f = await fixture(); await f.repository.upsert({ eventId: 'one', resource: session('old', 1) });
 await appendFile(f.options.journalFile, '{torn-tail');
 const before = await readFile(f.options.journalFile, 'utf8'); const snap = await readFile(f.options.snapshotFile, 'utf8');
 const observer = new FileNativeReadRepository({ ...f.options, readOnly: true });
 expect(await observer.list('session')).toHaveLength(1);
 await expect(observer.upsert({ eventId: 'two', resource: session('new', 2) })).rejects.toThrow('read-only');
 expect(await readFile(f.options.journalFile, 'utf8')).toBe(before);
 expect(await readFile(f.options.snapshotFile, 'utf8')).toBe(snap);
});
it('replays durable writes made between derived-index checkpoints', async () => {
 const f = await fixture(); const writer = new FileNativeReadRepository({ ...f.options, snapshotEvery: 250 });
 await writer.upsert({ eventId: 'before-checkpoint', resource: session('one', 1) });
 expect(await new FileNativeReadRepository(f.options).list('session')).toHaveLength(1);
});
it('name enrichment and stale bootstrap cannot move activity time or replace newer evidence', async () => {
 const f = await fixture(); const model = new ManagementReadModel(f.repository);
 const recent=session('s',2); recent.revision=3; await model.accept('a', snapshotChange(recent));
 await model.accept('a', snapshotChange(session('s',1)));
 const before=(await model.page(10)).items[0]!.session.lastActivityAt;
 await model.accept('a', snapshotChange({ resourceType:'identity', id:'u', profileId:'p', revision:1,
  kind:'user', displayName:'魏杰', resolutionStatus:'resolved', createdAt:'2026-09-08T10:00:00Z',updatedAt:'2026-09-08T10:00:00Z' }));
 expect((await model.page(10)).items[0]!.session.lastActivityAt).toBe(before);
 expect(before).toContain('02.000Z');
});
