import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeMessageReadProjector } from '../../../src/application/control/native-message-read-projector';
import { NativeAuditRecorder } from '../../../src/application/control/native-audit-recorder';
import { NativeRunAuditSink } from '../../../src/application/control/native-run-audit-sink';
import type {
  NativeChatMemberResource,
  NativeChatResource,
  NativeIdentityResource,
  NativeMessageResource,
  NativeRunResource,
  NativeSessionResource,
} from '../../../src/application/control/native-read-types';
import { FileNativeReadRepository } from '../../../src/platform/file-native-read-repository';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('NativeMessageReadProjector', () => {
  it('durably records a pending message and resolves it when the engine session becomes authoritative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-message-read-'));
    roots.push(root);
    const journalFile = join(root, 'changes.jsonl');
    const repository = new FileNativeReadRepository({
      profileId: '***REMOVED***', snapshotFile: join(root, 'snapshot.json'), journalFile,
    });
    const projector = new NativeMessageReadProjector({ profileId: '***REMOVED***', repository });
    const runSink = new NativeRunAuditSink({
      profileId: '***REMOVED***', repository,
      recorder: new NativeAuditRecorder({ profileId: '***REMOVED***', repository }),
    });
    await runSink.record({
      eventId: 'run-secret:started', sourceRunId: 'run-secret', action: 'run.started',
      occurredAt: '2026-08-26T23:59:59.000Z', outcome: 'success',
    });
    await projector.observe({
      eventId: 'inbound:om_secret', sourceMessageId: 'om_secret', direction: 'inbound',
      conversationKey: 'oc_secret', occurredAt: '2026-08-27T00:00:00.000Z',
      conversationKind: 'group', actorSourceId: 'ou_secret', actorKind: 'user',
      actorDisplayName: 'Ada',
      content: { format: 'plain-text', text: 'real prompt' },
      attachmentSourceIds: ['image-secret'],
    });
    const [pending] = await repository.list<NativeMessageResource>('message');
    expect(pending).toMatchObject({
      associationStatus: 'pending', sequence: 1,
      attachmentIds: [expect.stringMatching(/^att_/)],
    });
    expect(pending).not.toHaveProperty('sessionId');

    const binding = {
      bindingId: 'run-1:session', correlationId: 'im:om_secret', conversationKey: 'oc_secret',
      conversationKind: 'group',
      sourceRunId: 'run-secret', agentKind: 'codex', sourceSessionId: 'thread-secret',
      sourceMessageIds: ['om_secret'], occurredAt: '2026-08-27T00:00:01.000Z',
    } as const;
    await projector.bind(binding);
    const [message] = await repository.list<NativeMessageResource>('message');
    const [session] = await repository.list<NativeSessionResource>('session');
    const [run] = await repository.list<NativeRunResource>('run');
    const [identity] = await repository.list<NativeIdentityResource>('identity');
    const [chat] = await repository.list<NativeChatResource>('chat');
    const [membership] = await repository.list<NativeChatMemberResource>('chat-member');
    expect(message).toMatchObject({ associationStatus: 'resolved', sessionId: session?.id, runId: expect.stringMatching(/^run_/) });
    expect(session).toMatchObject({
      agentKind: 'codex', status: 'active', participantIdentityIds: [identity?.id], chatId: chat?.id,
    });
    expect(identity).toMatchObject({ kind: 'user', displayName: 'Ada', resolutionStatus: 'resolved' });
    expect(chat).toMatchObject({ kind: 'group', resolutionStatus: 'pending' });
    expect(membership).toMatchObject({ chatId: chat?.id, identityId: identity?.id, role: 'unknown' });
    expect(run).toMatchObject({ sessionId: session?.id, associationStatus: 'resolved', status: 'running' });
    await runSink.record({
      eventId: 'run-secret:completed', sourceRunId: 'run-secret', action: 'run.completed',
      occurredAt: '2026-08-27T00:00:01.500Z', outcome: 'success',
    });
    expect(await repository.list<NativeRunResource>('run')).toEqual([
      expect.objectContaining({ sessionId: session?.id, associationStatus: 'resolved', status: 'completed' }),
    ]);
    const cursor = await repository.currentCursor();
    await projector.bind(binding);
    expect(await repository.currentCursor()).toBe(cursor);
    const journal = await readFile(journalFile, 'utf8');
    for (const raw of [
      'om_secret', 'oc_secret', 'ou_secret', 'thread-secret', 'run-secret', 'image-secret',
    ]) {
      expect(journal).not.toContain(raw);
    }
    expect(journal).toContain('real prompt');

    await projector.remove('om_secret', '2026-08-27T00:00:02.000Z');
    expect(await repository.list<NativeMessageResource>('message')).toEqual([]);
  });

  it('associates successful outbound receipts through the run correlation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-message-read-'));
    roots.push(root);
    const repository = new FileNativeReadRepository({
      profileId: '***REMOVED***', snapshotFile: join(root, 'snapshot.json'), journalFile: join(root, 'changes.jsonl'),
    });
    const projector = new NativeMessageReadProjector({ profileId: '***REMOVED***', repository });
    await projector.bind({
      bindingId: 'run-1:session', correlationId: 'im:om_trigger', conversationKey: 'oc_chat',
      conversationKind: 'p2p',
      sourceRunId: 'run-1', agentKind: 'claude', sourceSessionId: 'session-1',
      sourceMessageIds: [], occurredAt: '2026-08-27T00:00:00.000Z',
    });
    await projector.observe({
      eventId: 'outbound:om_reply', sourceMessageId: 'om_reply', direction: 'outbound',
      conversationKey: 'oc_chat', correlationId: 'im:om_trigger',
      conversationKind: 'p2p', occurredAt: '2026-08-27T00:00:01.000Z',
      content: { format: 'markdown', text: 'answer' },
    });
    expect(await repository.list<NativeMessageResource>('message')).toEqual([
      expect.objectContaining({ direction: 'outbound', associationStatus: 'resolved', role: 'assistant' }),
    ]);
  });

  it('accumulates participants when one binding grows to include a reply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-message-read-'));
    roots.push(root);
    const repository = new FileNativeReadRepository({
      profileId: '***REMOVED***', snapshotFile: join(root, 'snapshot.json'), journalFile: join(root, 'changes.jsonl'),
    });
    const projector = new NativeMessageReadProjector({ profileId: '***REMOVED***', repository });
    await projector.observe({
      eventId: 'inbound:one', sourceMessageId: 'one', direction: 'inbound',
      conversationKey: 'chat', conversationKind: 'p2p', correlationId: 'turn',
      occurredAt: '2026-08-27T00:00:00.000Z', actorSourceId: 'user', actorKind: 'user',
      content: { format: 'plain-text', text: 'question' },
    });
    const baseBinding = {
      bindingId: 'run:session', correlationId: 'turn', conversationKey: 'chat',
      conversationKind: 'p2p', sourceRunId: 'run', agentKind: 'codex',
      sourceSessionId: 'thread', occurredAt: '2026-08-27T00:00:01.000Z',
    } as const;
    await projector.bind({ ...baseBinding, sourceMessageIds: ['one'] });
    await projector.observe({
      eventId: 'outbound:two', sourceMessageId: 'two', direction: 'outbound',
      conversationKey: 'chat', conversationKind: 'p2p', correlationId: 'turn',
      occurredAt: '2026-08-27T00:00:02.000Z', actorSourceId: 'bot', actorKind: 'bot',
      content: { format: 'plain-text', text: 'answer' },
    });
    const expanded = {
      ...baseBinding,
      sourceMessageIds: ['one', 'two'],
      occurredAt: '2026-08-27T00:00:03.000Z',
    } as const;
    await projector.bind(expanded);

    const [session] = await repository.list<NativeSessionResource>('session');
    const identities = await repository.list<NativeIdentityResource>('identity');
    expect(session?.participantIdentityIds).toEqual(identities.map(({ id }) => id).sort());
    expect(session?.lastActivityAt).toBe('2026-08-27T00:00:03.000Z');
    const cursor = await repository.currentCursor();
    await projector.bind(expanded);
    expect(await repository.currentCursor()).toBe(cursor);
  });
});
