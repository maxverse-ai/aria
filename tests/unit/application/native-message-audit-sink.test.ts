import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAuditRecorder } from '../../../src/application/control/native-audit-recorder';
import { NativeMessageAuditSink } from '../../../src/application/control/native-message-audit-sink';
import type { NativeAuditEventResource } from '../../../src/application/control/native-read-types';
import { FileNativeReadRepository } from '../../../src/platform/file-native-read-repository';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('NativeMessageAuditSink', () => {
  it('persists opaque actor/chat references without native message, chat or user IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-message-audit-'));
    roots.push(root);
    const journalFile = join(root, 'changes.jsonl');
    const repository = new FileNativeReadRepository({ profileId: 'demo', snapshotFile: join(root, 'snapshot.json'), journalFile });
    const sink = new NativeMessageAuditSink('demo', new NativeAuditRecorder({ profileId: 'demo', repository }));
    await sink.record({ eventId: 'inbound:om_secret', direction: 'inbound', conversationKey: 'oc_secret',
      occurredAt: '2026-08-27T00:00:00.000Z', sourceMessageId: 'om_secret', actorSourceId: 'ou_secret', actorKind: 'bot' });

    const [event] = await repository.list<NativeAuditEventResource>('audit-event');
    expect(event).toMatchObject({ action: 'message.received', actor: { kind: 'bot', identityId: expect.stringMatching(/^idn_/) },
      target: { resourceType: 'chat', resourceId: expect.stringMatching(/^cht_/) } });
    const journal = await readFile(journalFile, 'utf8');
    for (const raw of ['om_secret', 'oc_secret', 'ou_secret']) expect(journal).not.toContain(raw);
  });
});
