import { describe, expect, it } from 'vitest';
import { fixture, observation, authorize } from './helpers';
import type { TrustedObservation } from '../../../src/space/authorization';
import { spaceId } from '../../../src/space/identity';

describe('trusted space bindings', () => {
  it('M1: absent mode stays in the default space, even for a group', async () => {
    const f = fixture();
    const context = await f.authorization.authorize({ observation: observation(f.source, { kind: 'group' }), scopeRef: 'group', admitted: true, accessCeiling: 'full' });
    expect(f.authorization.inspect(context).binding.key).toEqual({ kind: 'default', profileId: 'profile' });
    expect(f.authorization.inspect(context).executionScope).toBe('group');
  });
  it('M3/M4: DM and exclusive groups share one user environment but distinct scopes; ordinary groups share another', async () => {
    const f = fixture();
    const contexts = await Promise.all([
      authorize(f), authorize(f, { conversationId: 'solo-1', kind: 'group' }),
      authorize(f, { conversationId: 'solo-2', kind: 'group' }),
      authorize(f, { conversationId: 'public-1', kind: 'group', humans: ['a', 'b'] }),
      authorize(f, { conversationId: 'public-2', kind: 'group', humans: ['a', 'b', 'c'] }),
      authorize(f, { conversationId: 'dm-b', actorId: 'b', humans: ['b'] }),
    ]);
    const views = contexts.map((context) => f.authorization.inspect(context));
    expect(new Set(views.slice(0, 3).map((v) => v.binding.spaceId)).size).toBe(1);
    expect(new Set(views.map((v) => v.executionScope)).size).toBe(6);
    expect(views[3]!.binding.spaceId).toBe(views[4]!.binding.spaceId);
    expect(new Set([views[0], views[3], views[5]].map((v) => v!.binding.spaceId)).size).toBe(3);
  });
  it('M5: identical subject ids in separate accounts never share a space', async () => {
    const left = fixture('left'); const right = fixture('right');
    expect(left.authorization.inspect(await authorize(left)).binding.spaceId)
      .not.toBe(right.authorization.inspect(await authorize(right)).binding.spaceId);
  });
  it.each([
    { complete: false }, { selfId: 'another-bot' }, { humans: ['a', 'a'] },
    { actorId: 'not-in-roster' }, { authenticated: false },
    { actorKind: 'agent' as const }, { observedAt: 2000 }, { expiresAt: 999 },
  ])('I1/I2: rejects invalid evidence even when input explicitly mentions the bot: %j', async (invalid) => {
    await expect(authorize(fixture(), invalid)).rejects.toThrow();
  });
  it('I1: rejects a copied or model-forged observation object', async () => {
    const f = fixture();
    await expect(f.authorization.authorize({ observation: {} as TrustedObservation, scopeRef: 'x', admitted: true, mode: 'team', accessCeiling: 'full' }))
      .rejects.toThrow('untrusted');
  });
  it('I3/I4: adding a member fences private output and removing members never revives the old epoch', async () => {
    const f = fixture();
    const privateRun = await authorize(f, { conversationId: 'group', kind: 'group' });
    const old = f.authorization.inspect(privateRun);
    const sharedRun = await authorize(f, { conversationId: 'group', kind: 'group', humans: ['a', 'b'], revision: 2 });
    expect(() => f.authorization.inspect(privateRun)).toThrow('stale');
    expect(f.authorization.inspect(sharedRun).binding.key.kind).toBe('shared');
    const privateAgain = await authorize(f, { conversationId: 'group', kind: 'group', revision: 3 });
    expect(f.authorization.inspect(privateAgain).executionScope).not.toBe(old.executionScope);
    await expect(authorize(f, { conversationId: 'group', kind: 'group', humans: ['a', 'b'], revision: 2 })).rejects.toThrow('stale');
    expect(f.authorization.inspect(privateAgain).binding.version).toBe(3);
  });
  it('I3: one human and another bot is shared, and failed refresh suspends an existing private binding', async () => {
    const f = fixture();
    const shared = await authorize(f, { kind: 'group', agents: ['bot', 'other'] });
    expect(f.authorization.inspect(shared).binding.key.kind).toBe('shared');
    const personal = await authorize(f, { conversationId: 'solo', kind: 'group' });
    await expect(authorize(f, { conversationId: 'solo', kind: 'group', complete: false, revision: 2 })).rejects.toThrow();
    expect(() => f.authorization.inspect(personal)).toThrow('suspended');
  });
  it('rejects cross-profile or non-human user space keys', () => {
    expect(() => spaceId({ kind: 'user', profileId: 'a', principal: { profileId: 'b', authorityId: 'x', subjectId: 'a', kind: 'user' } })).toThrow();
    expect(() => spaceId({ kind: 'user', profileId: 'a', principal: { profileId: 'a', authorityId: 'x', subjectId: 'a', kind: 'agent' } })).toThrow();
  });
});
