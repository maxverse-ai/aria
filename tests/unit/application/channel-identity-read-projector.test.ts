import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelIdentityReadProjector } from '../../../src/application/control/channel-identity-read-projector';
import { FileNativeReadRepository } from '../../../src/platform/file-native-read-repository';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('ChannelIdentityReadProjector', () => {
  it('projects a resolved group owner name without exposing Lark IDs', async () => {
    const { repository, projector } = await setup();
    const result = await projector.project({
      sourceChatId: 'oc_private_chat', kind: 'group', name: 'Architecture',
      resolutionStatus: 'resolved', observedAt: '2026-08-27T00:00:00.000Z',
      owner: { sourceIdentityId: 'ou_private_owner', kind: 'user', displayName: 'Ada', resolutionStatus: 'resolved', observedAt: '2026-08-27T00:00:00.000Z' },
    });

    expect(result).toEqual({ identities: 1, chats: 1, memberships: 1 });
    expect(await repository.list('identity')).toEqual([expect.objectContaining({ displayName: 'Ada', resolutionStatus: 'resolved' })]);
    expect(await repository.list('chat-member')).toEqual([expect.objectContaining({ role: 'owner' })]);
    expect(JSON.stringify((await repository.changes(null)).changes)).not.toContain('ou_private_owner');
    expect(JSON.stringify((await repository.changes(null)).changes)).not.toContain('oc_private_chat');
  });

  it('preserves an explicit failure state instead of fabricating an owner', async () => {
    const { repository, projector } = await setup();
    await projector.project({
      sourceChatId: 'oc_chat', kind: 'group', resolutionStatus: 'failed',
      resolutionErrorCode: 'LARK_PERMISSION_DENIED', observedAt: '2026-08-27T00:00:00.000Z',
    });
    expect(await repository.list('chat')).toEqual([expect.objectContaining({
      resolutionStatus: 'failed', resolutionErrorCode: 'LARK_PERMISSION_DENIED',
    })]);
    expect(await repository.list('identity')).toEqual([]);
  });

  it('rejects a group marked resolved when no authoritative owner was observed', async () => {
    const { projector } = await setup();
    await expect(projector.project({
      sourceChatId: 'oc_chat', kind: 'group', resolutionStatus: 'resolved', observedAt: '2026-08-27T00:00:00.000Z',
    })).rejects.toThrow('requires an owner');
  });

  it('lazily links an opaque actor to a chat and remains idempotent', async () => {
    const { repository, projector } = await setup();
    const observation = {
      sourceChatId: 'oc_private_chat',
      chatKind: 'group',
      observedAt: '2026-08-27T00:00:00.000Z',
      actor: { sourceIdentityId: 'ou_private_member', kind: 'user' },
    } as const;

    expect(await projector.observeMessage(observation)).toEqual({
      identities: 1, chats: 1, memberships: 1,
    });
    const cursor = await repository.currentCursor();
    expect(await projector.observeMessage({
      ...observation,
      observedAt: '2026-08-27T00:00:01.000Z',
    })).toEqual({ identities: 0, chats: 0, memberships: 0 });
    expect(await repository.currentCursor()).toBe(cursor);
    expect(await repository.list('identity')).toEqual([
      expect.objectContaining({ kind: 'user', resolutionStatus: 'pending' }),
    ]);
    expect(await repository.list('chat')).toEqual([
      expect.objectContaining({ kind: 'group', resolutionStatus: 'pending' }),
    ]);
    expect(await repository.list('chat-member')).toEqual([
      expect.objectContaining({ role: 'unknown' }),
    ]);
    const journal = JSON.stringify((await repository.changes(null)).changes);
    expect(journal).not.toContain('oc_private_chat');
    expect(journal).not.toContain('ou_private_member');
  });

  it('enriches a pending actor from a newer name and ignores sparse or stale observations', async () => {
    const { repository, projector } = await setup();
    const base = {
      sourceChatId: 'oc_chat', chatKind: 'p2p' as const,
      actor: { sourceIdentityId: 'ou_member', kind: 'user' as const },
    };
    await projector.observeMessage({ ...base, observedAt: '2026-08-27T00:00:00.000Z' });
    await projector.observeMessage({
      ...base, observedAt: '2026-08-27T00:00:02.000Z',
      actor: { ...base.actor, displayName: 'Ada' },
    });
    await projector.observeMessage({ ...base, observedAt: '2026-08-27T00:00:03.000Z' });
    await projector.observeMessage({
      ...base, observedAt: '2026-08-27T00:00:01.000Z',
      actor: { ...base.actor, displayName: 'Old Name' },
    });

    expect(await repository.list('identity')).toEqual([
      expect.objectContaining({
        kind: 'user', displayName: 'Ada', resolutionStatus: 'resolved',
        lastResolvedAt: '2026-08-27T00:00:02.000Z',
      }),
    ]);
    const journal = JSON.stringify((await repository.changes(null)).changes);
    expect(journal).not.toContain('ou_member');
    expect(journal).not.toContain('Old Name');
  });

  it('updates a resolved display name from a newer channel observation', async () => {
    const { repository, projector } = await setup();
    const actor = { sourceIdentityId: 'ou_member', kind: 'user' as const };
    await projector.observeMessage({
      sourceChatId: 'oc_chat', observedAt: '2026-08-27T00:00:00.000Z',
      actor: { ...actor, displayName: 'Ada' },
    });
    await projector.observeMessage({
      sourceChatId: 'oc_chat', observedAt: '2026-08-27T00:00:01.000Z',
      actor: { ...actor, displayName: 'Ada Lovelace' },
    });

    expect(await repository.list('identity')).toEqual([
      expect.objectContaining({
        displayName: 'Ada Lovelace', resolutionStatus: 'resolved',
        lastResolvedAt: '2026-08-27T00:00:01.000Z',
      }),
    ]);
  });

  it('upgrades lazy topology and never downgrades enriched resources', async () => {
    const { repository, projector } = await setup();
    await projector.observeMessage({
      sourceChatId: 'oc_chat', chatKind: 'group', observedAt: '2026-08-27T00:00:00.000Z',
      actor: { sourceIdentityId: 'ou_owner', kind: 'user' },
    });
    await projector.project({
      sourceChatId: 'oc_chat', kind: 'group', name: 'Architecture',
      resolutionStatus: 'resolved', observedAt: '2026-08-27T00:00:01.000Z',
      owner: {
        sourceIdentityId: 'ou_owner', kind: 'user', displayName: 'Ada',
        resolutionStatus: 'resolved', observedAt: '2026-08-27T00:00:01.000Z',
      },
    });
    const cursor = await repository.currentCursor();
    await projector.observeMessage({
      sourceChatId: 'oc_chat', chatKind: 'group', observedAt: '2026-08-27T00:00:02.000Z',
      actor: { sourceIdentityId: 'ou_owner', kind: 'unknown' },
    });

    expect(await repository.currentCursor()).toBe(cursor);
    expect(await repository.list('identity')).toEqual([
      expect.objectContaining({ kind: 'user', displayName: 'Ada', resolutionStatus: 'resolved' }),
    ]);
    expect(await repository.list('chat')).toEqual([
      expect.objectContaining({ name: 'Architecture', resolutionStatus: 'resolved' }),
    ]);
    expect(await repository.list('chat-member')).toEqual([
      expect.objectContaining({ role: 'owner' }),
    ]);
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'aria-channel-read-'));
  roots.push(root);
  const repository = new FileNativeReadRepository({
    profileId: '***REMOVED***', snapshotFile: join(root, 'snapshot.json'), journalFile: join(root, 'changes.jsonl'),
  });
  return { repository, projector: new ChannelIdentityReadProjector('***REMOVED***', repository) };
}
