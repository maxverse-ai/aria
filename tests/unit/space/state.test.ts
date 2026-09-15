import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, authorize } from './helpers';
import { SpaceStateStore, assertNativeSession } from '../../../src/space/state';
import { assertConfinedPath } from '../../../src/space/paths';
import { SpaceBindingStore } from '../../../src/space/bindings';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'aria-space-state-')); roots.push(value); return value; }

describe('space state', () => {
  it('D1/D2: sessions and workspace mapping remain disjoint through restart', async () => {
    const f = fixture(); const a = await authorize(f);
    const b = await authorize(f, { conversationId: 'dm-b', actorId: 'b', humans: ['b'] });
    const directory = await root(); const store = new SpaceStateStore(directory, f.authorization);
    const left = await store.view(a); const right = await store.view(b);
    left.sessions.set('same-scope', 'private-a', left.paths.workspace);
    expect(right.sessions.getRaw('same-scope')).toBeUndefined();
    await store.flush();
    const restarted = new SpaceStateStore(directory, f.authorization);
    expect((await restarted.view(a)).sessions.getRaw('same-scope')?.sessionId).toBe('private-a');
    expect((await restarted.view(b)).sessions.getRaw('same-scope')).toBeUndefined();
    f.authorization.revoke(f.authorization.inspect(a).grantId);
    expect(() => left.sessions.getRaw('same-scope')).toThrow('revoked');
  });
  it('D3: rejects traversal and symlinks to a sibling private directory', async () => {
    const directory = await root(); const own = join(directory, 'a'); const other = join(directory, 'b');
    await mkdir(own); await mkdir(other); await writeFile(join(other, 'secret'), 'private');
    await symlink(other, join(own, 'link'));
    await expect(assertConfinedPath(own, join(own, '..', 'b', 'secret'))).rejects.toThrow('escapes');
    await expect(assertConfinedPath(own, join(own, 'link', 'secret'))).rejects.toThrow('symlink');
  });
  it('D1/L4: native handles are space, binding and engine tagged', async () => {
    const f = fixture(); const c = await authorize(f); const s = f.authorization.inspect(c);
    const handle = { schema: 'aria.space.native-session.v1' as const, spaceId: s.binding.spaceId,
      bindingRef: s.binding.ref, engineId: 'codex', scopeRef: s.scopeRef, nativeId: 'thread' };
    expect(() => assertNativeSession(handle, c, f.authorization, 'codex')).not.toThrow();
    expect(() => assertNativeSession(handle, c, f.authorization, 'grok')).toThrow('foreign');
    expect(() => assertNativeSession({ ...handle, spaceId: 'other' }, c, f.authorization, 'codex')).toThrow('foreign');
  });
  it('D2/I4: restart requires fresh audience evidence before pending output can be read', async () => {
    const file = join(await root(), 'bindings.json');
    const f = fixture(); const c = await authorize(f); const binding = f.authorization.inspect(c).binding;
    await writeFile(file, JSON.stringify({ schema: 'aria.space.bindings.v1', bindings: [binding] }));
    const bindings = new SpaceBindingStore(file); await bindings.load();
    expect(() => bindings.assertCurrent(binding, 1000)).toThrow('stale');
  });
});
