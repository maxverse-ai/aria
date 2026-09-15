import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpaceWorkspaces } from '../../../src/space/workspace';
import { normalizeSpaceWorkspaces, type SpaceWorkspacesDefinition, type WorkspaceBundle } from '../../../src/space/workspace-definition';
import { digest } from '../../../src/space/deployment';
import { resolveSpacePaths } from '../../../src/space/paths';
import { authorize, fixture } from './helpers';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function bundle(revision = 'v1'): WorkspaceBundle {
  return { id: 'example', revision, entry: 'AGENTS.md', resources: [], skills: [{ name: 'review', directory: 'skills/review' }],
    files: Object.entries({ 'AGENTS.md': '# Project\nRead .aria/resources.json and .aria/skills.md as needed.\n',
      'rules.md': 'Detailed rules ' + revision,
      'skills/review/SKILL.md': '---\nname: review\ndescription: Review a sample project.\n---\nRead references/rules.md.\n',
      'skills/review/references/rules.md': 'Review rules ' + revision,
    }).map(([path, contents]) => ({ path, contents, sha256: digest(contents) })) };
}
async function setup(engineId = 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'aria-workspace-')); roots.push(root);
  const f = fixture(), context = await authorize(f), key = f.authorization.inspect(context).binding.key;
  const paths = resolveSpacePaths(root, key);
  const definition = (b = bundle()): SpaceWorkspacesDefinition => ({ schema: 'aria.space.workspaces.v1', bundles: [b], assignments: [{ space: key, bundle: b.id }] });
  const owner = (d = definition(), driver = 'trusted-process', availableTools: { id: string; revision: string }[] = []) => new SpaceWorkspaces({ profileId: 'profile', directory: root,
    authorization: f.authorization, engineId, driver, definition: d, availableTools });
  return { root, f, context, key, paths, definition, owner };
}
describe('business workspace provisioning', () => {
  it('keeps status read-only, coalesces first execution and supplies only a short per-run index', async () => {
    const s = await setup(), owner = s.owner();
    expect((await owner.status(s.context)).status).toBe('pending');
    expect(await readdir(s.root)).toEqual([]);
    await Promise.all([owner.prepare(s.context), owner.prepare(s.context)]);
    expect(await readFile(join(s.paths.workspace, 'AGENTS.md'), 'utf8')).toBe(bundle().files[0]!.contents);
    expect(await readFile(join(s.paths.home, '.codex/skills/review/references/rules.md'), 'utf8')).toBe('Review rules v1');
    const prompt = await owner.runInstructions(s.context, 'run-one');
    expect(prompt!.split('\n')).toHaveLength(5);
    expect(prompt).not.toContain('Detailed rules');
    expect(prompt).not.toContain('dm-a');
    expect(prompt).not.toBe(await owner.runInstructions(s.context, 'run-two'));
    expect((await owner.status(s.context)).status).toBe('ready');
    expect((await owner.status(s.context)).discovery).toBe('not-checked');
    await owner.recordDiscovery(s.key);
    expect((await owner.status(s.context)).discovery).toBe('native-verified');
    await owner.close();
    await expect(owner.prepare(s.context)).rejects.toThrow('closed');
  });
  it('preserves an existing AGENTS and historical artifacts while providing a separate business entry', async () => {
    const s = await setup();
    await mkdir(s.paths.workspace, { recursive: true });
    await writeFile(join(s.paths.workspace, 'AGENTS.md'), 'User-owned instructions');
    await writeFile(join(s.paths.workspace, 'old-report.md'), 'private report');
    const owner = s.owner(); await owner.prepare(s.context);
    expect((await owner.status(s.context)).preservedAgents).toBe(true);
    expect(await readFile(join(s.paths.workspace, 'AGENTS.md'), 'utf8')).toBe('User-owned instructions');
    expect(await readFile(join(s.paths.workspace, 'old-report.md'), 'utf8')).toBe('private report');
    expect(await readFile(join(s.paths.workspace, '.aria/space-guide.md'), 'utf8')).toContain('# Project');
    await owner.close();
  });
  it('updates only owned unchanged files and can roll back without touching outputs', async () => {
    const s = await setup(), first = s.owner(); await first.prepare(s.context);
    await writeFile(join(s.paths.workspace, 'report.md'), 'retain'); await first.close();
    const second = s.owner(s.definition(bundle('v2')));
    expect((await second.plan(s.key)).status).toBe('pending'); await second.prepare(s.context); await second.close();
    const rules = join(s.paths.workspace, '.aria/business/example/rules.md');
    expect(await readFile(rules, 'utf8')).toBe('Detailed rules v2');
    const rollback = s.owner(); await rollback.prepare(s.context);
    expect(await readFile(rules, 'utf8')).toBe('Detailed rules v1');
    expect(await readFile(join(s.paths.workspace, 'report.md'), 'utf8')).toBe('retain');
    expect((await readdir(join(s.paths.control, 'workspace-revisions'))).length).toBe(2);
    await rollback.close();
  });
  it('preserves local changes and reports a conflict before writing any update', async () => {
    const s = await setup(), first = s.owner(); await first.prepare(s.context); await first.close();
    const native = join(s.paths.home, '.codex/skills/review/SKILL.md'); await writeFile(native, 'User modified skill');
    const next = s.owner(s.definition(bundle('v2')));
    expect((await next.plan(s.key)).conflicts).toContain('home/.codex/skills/review/SKILL.md');
    await expect(next.prepare(s.context)).rejects.toThrow('conflict');
    expect(await readFile(native, 'utf8')).toBe('User modified skill');
    expect(await readFile(join(s.paths.workspace, '.aria/business/example/rules.md'), 'utf8')).toBe('Detailed rules v1');
    await next.close();
  });
  it('preserves an additive local skill index and still rejects removal of managed entries', async () => {
    const s = await setup(), first = s.owner(); await first.prepare(s.context); await first.close();
    const file = join(s.paths.workspace, '.aria/skills.md');
    const generated = await readFile(file, 'utf8');
    const customized = generated + '- /local: ../skills/local/SKILL.md\n';
    await writeFile(file, customized);
    const second = s.owner();
    expect((await second.plan(s.key)).conflicts).toEqual([]);
    await second.prepareExisting(); await second.close();
    expect(await readFile(file, 'utf8')).toBe(customized);
    const third = s.owner(); await third.prepareExisting(); await third.close();
    expect(await readFile(file, 'utf8')).toBe(customized);
    await writeFile(file, '# Skills\nUser replaced managed entries\n');
    const fourth = s.owner();
    expect((await fourth.plan(s.key)).conflicts).toContain('workspace/.aria/skills.md');
    await fourth.close();
  });
  it('requires explicit read-only deployment admission for container workspace resources', async () => {
    const s = await setup(), resource = join(s.root, 'reference'); await mkdir(resource);
    const b = bundle(); b.resources = [{ name: 'reference', path: resource, access: 'read-only' }];
    const owner = (readonlyResources: string[]) => new SpaceWorkspaces({ profileId: 'profile', directory: s.root,
      authorization: s.f.authorization, engineId: 'codex', driver: 'execution', definition: s.definition(b), readonlyResources });
    const denied = owner([]); expect((await denied.plan(s.key)).status).toBe('conflict'); await denied.close();
    const admitted = owner([resource]); await admitted.prepare(s.context);
    expect((await admitted.plan(s.key)).resources).toEqual([{ name: 'reference', available: true }]); await admitted.close();
  });
  it('does not distribute a personal assignment to another user or a newly shared group', async () => {
    const s = await setup(), owner = s.owner();
    const other = await authorize(s.f, { conversationId: 'dm-b', actorId: 'b', humans: ['b'] });
    const group = await authorize(s.f, { conversationId: 'group', kind: 'group', humans: ['a', 'b'] });
    for (const context of [other, group]) {
      await owner.prepare(context); expect(await owner.runInstructions(context, 'run')).toBeUndefined();
      expect((await owner.status(context)).status).toBe('unassigned');
    }
    expect(await readdir(s.root)).toEqual([]);
    const solo = await authorize(s.f, { conversationId: 'solo', kind: 'group' });
    await owner.prepare(solo);
    expect((await owner.status(solo)).status).toBe('ready');
    expect(await owner.runInstructions(solo, 'same')).not.toBe(await owner.runInstructions(s.context, 'same'));
    await owner.close();
  });
  it('removes only managed assets on unassignment, retaining unrelated artifacts and custom instructions', async () => {
    const s = await setup(), first = s.owner(); await first.prepare(s.context); await first.close();
    await writeFile(join(s.paths.workspace, 'AGENTS.md'), 'customized');
    const removed = s.owner({ schema: 'aria.space.workspaces.v1', bundles: [], assignments: [] });
    await removed.prepare(s.context);
    expect((await removed.status(s.context)).status).toBe('unassigned');
    expect(await readFile(join(s.paths.workspace, 'AGENTS.md'), 'utf8')).toBe('customized');
    await expect(readFile(join(s.paths.home, '.codex/skills/review/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await removed.close();
  });
  it('returns a pre-existing restored skill to its original contents when the business assignment is withdrawn', async () => {
    const s = await setup();
    const native = join(s.paths.home, '.codex/skills/review/references/rules.md');
    await mkdir(join(s.paths.home, '.codex/skills/review/references'), { recursive: true });
    await writeFile(native, 'Review rules v1');
    const first = s.owner(); await first.prepare(s.context); await first.close();
    const update = s.owner(s.definition(bundle('v2'))); await update.prepare(s.context); await update.close();
    expect(await readFile(native, 'utf8')).toBe('Review rules v2');
    const rollback = s.owner({ schema: 'aria.space.workspaces.v1', bundles: [], assignments: [] });
    await rollback.prepare(s.context);
    expect(await readFile(native, 'utf8')).toBe('Review rules v1');
    await expect(readFile(join(s.paths.workspace, '.aria/space-guide.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await rollback.status(s.context)).status).toBe('unassigned');
    await rollback.close();
  });
  it('recovers a partially written transaction, without installing during status', async () => {
    const s = await setup(), first = s.owner(); await first.prepare(s.context); await first.close();
    const path = 'workspace/.aria/business/example/rules.md', contents = 'Recovered rules';
    const receipt = JSON.parse(await readFile(join(s.paths.control, 'workspace-setup.json'), 'utf8'));
    receipt.files[path] = digest(contents);
    const update = { schema: 'aria.workspace.journal.v1', receipt, changes: [{ path, before: 'Detailed rules v1', after: contents }] };
    await writeFile(join(s.paths.control, 'workspace-update.json'), JSON.stringify(update), { mode: 0o600 });
    await writeFile(join(s.paths.engine, path), contents); // crash before receipt commit
    const next = s.owner(); expect((await next.status(s.context)).status).toBe('recovery-required');
    await next.prepare(s.context);
    expect(await readFile(join(s.paths.engine, path), 'utf8')).toBe('Detailed rules v1');
    await expect(readFile(join(s.paths.control, 'workspace-update.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await next.close();
  });
  it('rejects symlink targets, unavailable resources and unsupported isolated external resources', async () => {
    const s = await setup(); await mkdir(s.paths.workspace, { recursive: true });
    await symlink(s.root, join(s.paths.workspace, '.aria'));
    await expect(s.owner().prepare(s.context)).rejects.toThrow('symlink');
    await rm(join(s.paths.workspace, '.aria'));
    const b = bundle(); b.resources = [{ name: 'project', path: join(s.root, 'missing'), access: 'read-only' }];
    expect((await s.owner(s.definition(b)).status(s.context)).resources).toEqual([{ name: 'project', available: false }]);
    b.resources = [{ name: 'project', path: s.root, access: 'read-only' }];
    await expect(s.owner(s.definition(b), 'execution').prepare(s.context)).rejects.toThrow('conflict');
  });
  it.each(['claude', 'grok', 'opencode', 'pi', 'kimi', 'dsh'])('provides an explicit lazy catalog for %s without claiming native verification', async engine => {
    const s = await setup(engine), owner = s.owner(); await owner.prepare(s.context); await owner.recordDiscovery(s.key);
    expect(await readFile(join(s.paths.workspace, '.aria/skills.md'), 'utf8')).toContain('/review:');
    expect((await owner.status(s.context)).discovery).toBe('explicit-catalog');
    await expect(readFile(join(s.paths.home, '.codex/skills/review/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await owner.close();
  });
  it('rejects excessive navigation, asset tampering, traversal and cross-profile assignments', async () => {
    const s = await setup();
    for (const contents of ['line\n'.repeat(21), 'x'.repeat(2049)]) {
      const b = bundle(); b.files[0]!.contents = contents; b.files[0]!.sha256 = digest(contents);
      expect(() => normalizeSpaceWorkspaces(s.definition(b), 'profile')).toThrow('navigation');
    }
    const b = bundle(); b.files[1]!.contents = 'tampered';
    expect(() => normalizeSpaceWorkspaces(s.definition(b), 'profile')).toThrow('asset');
    b.files[1]!.path = '../escape'; expect(() => normalizeSpaceWorkspaces(s.definition(b), 'profile')).toThrow();
    expect(() => normalizeSpaceWorkspaces(s.definition(), 'other-profile')).toThrow('profile');
  });
  it('defaults provision a future admitted user while exact personal skills stay private', async () => {
    const s = await setup(), shared = bundle(); shared.id = 'common'; shared.skills = [];
    shared.files = shared.files.filter(f => !f.path.startsWith('skills/'));
    const definition = s.definition(); definition.bundles = [...definition.bundles, shared];
    definition.defaults = ['user', 'shared'].map(kind => ({ kind: kind as 'user' | 'shared', authorityId: s.f.source.authorityId, bundle: 'common' }));
    const owner = s.owner(definition);
    const future = await authorize(s.f, { conversationId: 'future', actorId: 'new-user', humans: ['new-user'] });
    const group = await authorize(s.f, { conversationId: 'shared', kind: 'group', humans: ['a', 'new-user'] });
    for (const context of [future, group]) {
      expect((await owner.status(context)).selection).toBe('default');
      await owner.prepare(context);
      const paths = resolveSpacePaths(s.root, s.f.authorization.inspect(context).binding.key);
      expect(await readFile(join(paths.workspace, 'AGENTS.md'), 'utf8')).toContain('# Project');
      expect(await readFile(join(paths.workspace, '.aria/skills.md'), 'utf8')).not.toContain('/review:');
      await expect(readFile(join(paths.home, '.codex/skills/review/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await owner.prepare(s.context);
    expect((await owner.status(s.context)).selection).toBe('explicit');
    expect(await readFile(join(s.paths.home, '.codex/skills/review/SKILL.md'), 'utf8')).toContain('Review a sample');
    expect((await owner.plan({ kind: 'default', profileId: 'profile' })).status).toBe('unassigned');
    const other = fixture('other-account'), foreign = await authorize(other);
    expect((await owner.plan(other.authorization.inspect(foreign).binding.key)).status).toBe('unassigned');
    await owner.close();
  });
  it('an explicit opt-out defeats defaults and a definition remains a startup snapshot', async () => {
    const s = await setup(), definition = s.definition();
    definition.defaults = [{ kind: 'user', authorityId: s.f.source.authorityId, bundle: 'example' }];
    definition.assignments = [{ space: s.key, bundle: null }];
    const owner = s.owner(definition); definition.assignments = [];
    await owner.prepare(s.context);
    expect((await owner.status(s.context)).status).toBe('unassigned');
    expect((await owner.status(s.context)).selection).toBe('explicit');
    expect(await readdir(s.root)).toEqual([]); await owner.close();
  });
  it('backfills existing workspaces without creating future Spaces or touching user instructions and histories', async () => {
    const s = await setup(), definition = s.definition();
    definition.defaults = [{ kind: 'user', authorityId: s.f.source.authorityId, bundle: 'example' }];
    const future = await authorize(s.f, { conversationId: 'future', actorId: 'b', humans: ['b'] });
    const futurePaths = resolveSpacePaths(s.root, s.f.authorization.inspect(future).binding.key);
    await mkdir(s.paths.workspace, { recursive: true });
    await writeFile(join(s.paths.workspace, 'AGENTS.md'), 'My own instructions');
    await writeFile(join(s.paths.workspace, 'history.md'), 'Existing report');
    const owner = s.owner(definition);
    const result = await owner.prepareExisting();
    expect(result).toHaveLength(1); expect(result[0]!.status).toBe('ready');
    expect(result[0]!.discovery).toBe('not-checked');
    expect(await readFile(join(s.paths.workspace, 'AGENTS.md'), 'utf8')).toBe('My own instructions');
    expect(await readFile(join(s.paths.workspace, 'history.md'), 'utf8')).toBe('Existing report');
    expect(await readFile(join(s.paths.workspace, '.aria/space-guide.md'), 'utf8')).toContain('# Project');
    await expect(readdir(futurePaths.root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await owner.prepareExisting()).toEqual(result);
    await owner.close();
    await expect(owner.prepareExisting()).rejects.toThrow('closed');
  });
  it('preflights all existing spaces before backfill and preserves conflicting files', async () => {
    const s = await setup(), definition = s.definition();
    definition.defaults = [{ kind: 'user', authorityId: s.f.source.authorityId, bundle: 'example' }];
    const other = await authorize(s.f, { conversationId: 'b', actorId: 'b', humans: ['b'] });
    const paths = resolveSpacePaths(s.root, s.f.authorization.inspect(other).binding.key);
    await mkdir(s.paths.workspace, { recursive: true });
    await mkdir(join(paths.workspace, '.aria'), { recursive: true });
    await writeFile(join(paths.workspace, '.aria/space-guide.md'), 'User edited guide');
    const owner = s.owner(definition);
    await expect(owner.prepareExisting()).rejects.toThrow('conflict-free');
    await expect(readFile(join(s.paths.workspace, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(paths.workspace, '.aria/space-guide.md'), 'utf8')).toBe('User edited guide');
    await owner.close();
  });
  it('rejects ambiguous, unscoped and invalid default definitions', async () => {
    const s = await setup();
    const rule = { kind: 'user', authorityId: s.f.source.authorityId, bundle: 'example' };
    for (const defaults of [[rule, rule], [{ ...rule, kind: 'default' }], [{ ...rule, authorityId: '' }],
      [{ ...rule, bundle: 'missing' }], [{ ...rule, subjectId: 'from-prompt' }]]) {
      expect(() => normalizeSpaceWorkspaces({ ...s.definition(), defaults }, 'profile')).toThrow();
    }
    expect(normalizeSpaceWorkspaces(s.definition(), 'profile').defaults).toBeUndefined();
  });
  it('adds common skills to exact business assignments, opt-outs and future admitted user/shared Spaces', async () => {
    const s = await setup(), common = bundle(); common.id = 'public';
    common.skills = [{ name: 'public-review', directory: 'skills/review' }];
    const definition = s.definition(); definition.bundles = [...definition.bundles, common];
    definition.common = ['user', 'shared'].map(kind => ({ kind: kind as 'user' | 'shared', authorityId: s.f.source.authorityId, bundles: ['public'] }));
    const future = await authorize(s.f, { conversationId: 'new', actorId: 'b', humans: ['b'] });
    const group = await authorize(s.f, { conversationId: 'group', kind: 'group', humans: ['a', 'b'] });
    definition.assignments = [...definition.assignments, { space: s.f.authorization.inspect(future).binding.key, bundle: null }];
    const owner = s.owner(definition);
    for (const context of [s.context, future, group]) {
      await owner.prepare(context);
      expect((await owner.status(context)).status).toBe('ready');
      expect((await owner.status(context)).common).toEqual([{ id: 'public', revision: 'v1' }]);
      const key = s.f.authorization.inspect(context).binding.key;
      expect(owner.skills(key)).toContain('public-review');
      expect(owner.skills(key).includes('review')).toBe(context === s.context);
      const paths = resolveSpacePaths(s.root, key);
      expect(await readFile(join(paths.home, '.codex/skills/public-review/SKILL.md'), 'utf8')).toContain('Review a sample');
    }
    expect((await owner.plan({ kind: 'default', profileId: 'profile' })).status).toBe('unassigned');
    const foreign = fixture('foreign');
    expect((await owner.plan(foreign.authorization.inspect(await authorize(foreign)).binding.key)).status).toBe('unassigned');
    await owner.close();
  });
  it('upgrades and removes only unchanged common assets without disturbing the project or historical outputs', async () => {
    const s = await setup(), first = s.owner(); await first.prepare(s.context); await first.close();
    await writeFile(join(s.paths.workspace, 'AGENTS.md'), 'User rules');
    await writeFile(join(s.paths.workspace, 'report.md'), 'History');
    const common = bundle(); common.id = 'public'; common.skills = [{ name: 'public-review', directory: 'skills/review' }];
    const definition = { ...s.definition(), bundles: [...s.definition().bundles, common],
      common: [{ kind: 'user' as const, authorityId: s.f.source.authorityId, bundles: [common.id] }] };
    const next = s.owner(definition); await next.prepareExisting();
    expect((await next.status(s.context)).discovery).toBe('not-checked');
    await next.recordDiscovery(s.key); expect((await next.status(s.context)).discovery).toBe('native-verified');
    await next.close();
    const rollback = s.owner(); await rollback.prepare(s.context);
    expect(await readFile(join(s.paths.workspace, 'AGENTS.md'), 'utf8')).toBe('User rules');
    expect(await readFile(join(s.paths.workspace, 'report.md'), 'utf8')).toBe('History');
    expect(await readFile(join(s.paths.home, '.codex/skills/review/SKILL.md'), 'utf8')).toContain('Review');
    await expect(readFile(join(s.paths.home, '.codex/skills/public-review/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rollback.close();
  });
  it('refuses ambiguous layer ownership and missing or stale host tool revisions before installation', async () => {
    const s = await setup(), common = bundle(); common.id = 'public';
    const definition = { ...s.definition(), bundles: [...s.definition().bundles, common],
      common: [{ kind: 'user' as const, authorityId: s.f.source.authorityId, bundles: [common.id] }] };
    expect(() => s.owner(definition)).toThrow('conflicting skill');
    common.skills = []; common.requiresTools = [{ id: 'public-tool', revision: 'v2' }];
    const missing = s.owner(definition);
    expect((await missing.status(s.context)).requiredTools).toEqual([{ id: 'public-tool', revision: 'v2', available: false }]);
    await expect(missing.prepare(s.context)).rejects.toThrow('conflict');
    expect(await readdir(s.root)).toEqual([]); await missing.close();
    const stale = s.owner(definition, 'trusted-process', [{ id: 'public-tool', revision: 'v1' }]);
    await expect(stale.prepare(s.context)).rejects.toThrow('conflict'); await stale.close();
    const good = s.owner(definition, 'trusted-process', [{ id: 'public-tool', revision: 'v2' }]);
    await good.prepare(s.context); expect((await good.status(s.context)).requiredTools![0]!.available).toBe(true); await good.close();
  });
  it('rejects unscoped common rules, duplicate selectors and unknown adapter fields', async () => {
    const s = await setup(), rule = { kind: 'user', authorityId: s.f.source.authorityId, bundles: ['example'] };
    for (const common of [[rule, rule], [{ ...rule, kind: 'default' }], [{ ...rule, authorityId: '' }],
      [{ ...rule, bundles: ['missing'] }], [{ ...rule, bundles: ['example', 'example'] }], [{ ...rule, principal: 'a' }]]) {
      expect(() => normalizeSpaceWorkspaces({ ...s.definition(), common }, 'profile')).toThrow();
    }
    const extension = { id: 'example', revision: 'v1', module: '/operator/extension.mjs', sha256: 'a'.repeat(64) };
    for (const extensions of [[{ ...extension, module: '../extension.mjs' }], [{ ...extension, token: 'forbidden' }], [extension, extension]]) {
      expect(() => normalizeSpaceWorkspaces({ ...s.definition(), extensions }, 'profile')).toThrow();
    }
  });
});
