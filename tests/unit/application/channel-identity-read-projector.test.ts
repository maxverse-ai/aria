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
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'aria-channel-read-'));
  roots.push(root);
  const repository = new FileNativeReadRepository({
    profileId: '***REMOVED***', snapshotFile: join(root, 'snapshot.json'), journalFile: join(root, 'changes.jsonl'),
  });
  return { repository, projector: new ChannelIdentityReadProjector('***REMOVED***', repository) };
}
