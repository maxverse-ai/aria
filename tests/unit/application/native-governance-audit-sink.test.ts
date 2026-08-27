import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAuditRecorder } from '../../../src/application/control/native-audit-recorder';
import { NativeGovernanceAuditSink } from '../../../src/application/control/native-governance-audit-sink';
import type { NativeAuditEventResource } from '../../../src/application/control/native-read-types';
import { FileNativeReadRepository } from '../../../src/platform/file-native-read-repository';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('NativeGovernanceAuditSink', () => {
  it('persists policy, attachment, and credential evidence with opaque identifiers only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-governance-audit-'));
    roots.push(root);
    const journalFile = join(root, 'changes.jsonl');
    const repository = new FileNativeReadRepository({
      profileId: '***REMOVED***', snapshotFile: join(root, 'snapshot.json'), journalFile,
    });
    const sink = new NativeGovernanceAuditSink(
      '***REMOVED***',
      new NativeAuditRecorder({ profileId: '***REMOVED***', repository }),
    );

    await sink.record({
      eventId: 'private-policy-event', action: 'policy.decided',
      occurredAt: '2026-08-27T00:00:00.000Z', outcome: 'denied', actorKind: 'user',
      actorSourceId: 'ou_private', conversationSourceId: 'oc_private',
      targetSourceId: 'private-policy-fingerprint', errorCode: 'ACCESS_DENIED',
    });
    await sink.record({
      eventId: 'private-attachment-event', action: 'attachment.written',
      occurredAt: '2026-08-27T00:00:01.000Z', outcome: 'success', actorKind: 'system',
      targetSourceId: 'private-file-key',
    });
    await sink.record({
      eventId: 'private-credential-event', action: 'credential.accessed',
      occurredAt: '2026-08-27T00:00:02.000Z', outcome: 'success', actorKind: 'system',
      targetSourceId: 'cli_private_app',
    });

    const events = await repository.list<NativeAuditEventResource>('audit-event');
    expect(events.map((event) => event.action).sort()).toEqual([
      'attachment.written', 'credential.accessed', 'policy.decided',
    ]);
    expect(events.find((event) => event.action === 'policy.decided')).toMatchObject({
      actor: { kind: 'user', identityId: expect.stringMatching(/^idn_/) },
      target: { resourceType: 'policy', resourceId: expect.stringMatching(/^pol_/) },
      conversationId: expect.stringMatching(/^cnv_/),
      outcome: 'denied',
      errorCode: 'ACCESS_DENIED',
      redacted: true,
    });
    expect(events.find((event) => event.action === 'attachment.written')?.target?.resourceId)
      .toMatch(/^att_/);
    expect(events.find((event) => event.action === 'credential.accessed')?.target?.resourceId)
      .toMatch(/^crd_/);
    const journal = await readFile(journalFile, 'utf8');
    for (const secret of [
      'private-policy-event', 'ou_private', 'oc_private', 'private-policy-fingerprint',
      'private-file-key', 'cli_private_app',
    ]) expect(journal).not.toContain(secret);
  });
});
