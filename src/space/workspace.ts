import { access, lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { nativeWorkspaceSkillFiles, workspaceSkillDelivery } from '../agent/runtime/workspace-assets';
import { SpaceAuthorization, type AuthorizedSpaceContext } from './authorization';
import { opaqueId, spaceId, type SpaceKey } from './identity';
import { assertConfinedPath, prepareSpacePaths, resolveSpacePaths, within, type SpacePaths } from './paths';
import { digest, readPrivateJson } from './deployment';
import { normalizeSpaceWorkspaces, selectWorkspaceLayers, workspaceRelativePath, type SpaceWorkspacesDefinition, type WorkspaceBundle } from './workspace-definition';

interface Receipt {
  schema: 'aria.workspace.receipt.v1'; spaceId: string; revision: string; bundle?: string;
  files: Record<string, string>; preservedAgents: boolean;
  /** Contents that predated provisioning, retained when management is removed. */
  baseline?: Record<string, string>;
}
interface Change { path: string; before: string | null; after: string | null }
interface Journal { schema: 'aria.workspace.journal.v1'; receipt: Receipt; changes: Change[] }
export interface WorkspaceSetupPlan {
  status: 'unassigned' | 'ready' | 'pending' | 'conflict' | 'recovery-required';
  selection: 'explicit' | 'default' | 'none';
  bundle?: string; revision?: string; delivery: ReturnType<typeof workspaceSkillDelivery>;
  common?: readonly { id: string; revision: string }[];
  requiredTools?: readonly { id: string; revision: string; available: boolean }[];
  changes: readonly { path: string; action: 'create' | 'update' | 'remove' }[];
  conflicts: readonly string[]; preservedAgents: boolean;
  resources: readonly { name: string; available: boolean }[];
  discovery: 'not-checked' | 'native-verified' | 'explicit-catalog';
}
interface Desired { files: Record<string, string>; bundle?: WorkspaceBundle; bundles: readonly WorkspaceBundle[];
  common: readonly WorkspaceBundle[]; revision: string; selection: WorkspaceSetupPlan['selection'] }

/** Profile-owned provisioning. It never infers assignments from a sender's
 * name, a prompt, or agent-editable files. The host already holds the profile
 * runtime lock. A definition is immutable for this owner's entire lifetime. */
export class SpaceWorkspaces {
  private readonly definition: SpaceWorkspacesDefinition;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly ready = new Set<string>();
  private readonly active = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly options: {
    profileId: string; directory: string; authorization: SpaceAuthorization;
    engineId: string; driver: string; definition: SpaceWorkspacesDefinition;
    availableTools?: readonly { id: string; revision: string }[];
    readonlyResources?: readonly string[];
  }) {
    this.definition = normalizeSpaceWorkspaces(options.definition, options.profileId);
  }

  /** Read-only, including for never-created spaces. Only the host/operator may
   * call this key-based view; end-user callers must first authorize context. */
  async plan(key: SpaceKey): Promise<WorkspaceSetupPlan> {
    const paths = this.paths(key), desired = this.desired(key);
    const { plan } = await this.compare(paths, desired);
    return plan;
  }
  status(context: AuthorizedSpaceContext): Promise<WorkspaceSetupPlan> {
    return this.plan(this.options.authorization.inspect(context).binding.key);
  }
  skills(key: SpaceKey): readonly string[] {
    return this.ready.has(spaceId(key)) ? this.desired(key).bundles.flatMap(b => b.skills.map(s => s.name)) : [];
  }
  async recordDiscovery(key: SpaceKey): Promise<void> {
    if (!this.ready.has(spaceId(key)) || !this.desired(key).bundles.length) return;
    const paths = this.paths(key);
    await this.atomic(paths.control, join(paths.control, 'workspace-discovery.json'), JSON.stringify({
      revision: this.desired(key).revision, delivery: workspaceSkillDelivery(this.options.engineId),
    }));
  }
  async prepare(context: AuthorizedSpaceContext): Promise<void> {
    const key = this.options.authorization.inspect(context).binding.key;
    await this.prepareKey(key);
    this.options.authorization.inspect(context);
    if (this.closed) throw new Error('workspace owner is closed');
  }
  /** Operator maintenance, invoked under the stopped profile's exclusive host
   * lock. Only persisted, physically existing Spaces are eligible. No source
   * observation, user authority, model process or conversation is fabricated. */
  async prepareExisting(): Promise<Array<{ spaceId: string } & WorkspaceSetupPlan>> {
    if (this.closed) throw new Error('workspace owner is closed');
    const keys: SpaceKey[] = [];
    for (const key of this.options.authorization.bindings.spaceKeys()) {
      const paths = this.paths(key);
      await assertConfinedPath(paths.root, paths.workspace);
      try {
        if (!(await lstat(paths.workspace)).isDirectory()) throw new Error('existing workspace is not a directory');
        keys.push(key);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const plans = await Promise.all(keys.map(key => this.plan(key)));
    if (plans.some(p => p.status === 'conflict' || p.status === 'recovery-required')) {
      throw new Error('existing workspace backfill requires conflict-free plans and completed recovery');
    }
    for (const key of keys) await this.prepareKey(key);
    return Promise.all(keys.map(async key => ({ spaceId: spaceId(key), ...await this.plan(key) })));
  }
  private async prepareKey(key: SpaceKey): Promise<void> {
    if (this.closed) throw new Error('workspace owner is closed');
    const id = spaceId(key);
    if (!this.ready.has(id)) {
      let work = this.pending.get(id);
      if (!work) {
        work = this.reconcile(key).then(() => { this.ready.add(id); }).finally(() => { this.pending.delete(id); this.active.delete(work!); });
        this.pending.set(id, work); this.active.add(work);
      }
      await work;
    }
    if (this.closed) throw new Error('workspace owner is closed');
  }
  async runInstructions(context: AuthorizedSpaceContext, runId: string): Promise<string | undefined> {
    const snapshot = this.options.authorization.inspect(context);
    if (!this.ready.has(snapshot.binding.spaceId) || this.closed) throw new Error('workspace is not prepared');
    const desired = this.desired(snapshot.binding.key);
    if (!desired.bundles.length) return undefined;
    if (!runId) throw new Error('workspace run requires a run identifier');
    const paths = this.paths(snapshot.binding.key);
    const output = join(paths.workspace, 'outputs', opaqueId('workspace-scope', [snapshot.executionScope]), opaqueId('workspace-run', [runId]));
    await assertConfinedPath(paths.workspace, output); await mkdir(output, { recursive: true, mode: 0o700 });
    this.options.authorization.inspect(context);
    // No task IDs, tokens or user grants are written into a shared guide.
    return ['Workspace navigation (read only as needed):',
      `Business entry: ${join(paths.workspace, '.aria', 'space-guide.md')}`,
      `Resources: ${join(paths.workspace, '.aria', 'resources.json')}`,
      `Skills: ${join(paths.workspace, '.aria', 'skills.md')} (for /skill-name, read its listed SKILL.md before using it)`,
      `This task's outputs: ${output}`].join('\n');
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.active]); }

  private paths(key: SpaceKey): SpacePaths {
    if (key.profileId !== this.options.profileId) throw new Error('workspace profile mismatch');
    return resolveSpacePaths(this.options.directory, key);
  }
  private desired(key: SpaceKey): Desired {
    const { bundle, selection, bundles, common } = selectWorkspaceLayers(this.definition, key);
    const files: Record<string, string> = {};
    if (bundles.length) {
      const entries: string[] = [], skills: string[] = [];
      for (const b of bundles) {
        const prefix = join('workspace', '.aria', common.includes(b) ? 'common' : 'business', b.id);
        for (const file of b.files) files[join(prefix, file.path)] = file.contents;
        entries.push(b.files.find(f => f.path === b.entry)!.contents);
        skills.push(...b.skills.map(s => `- /${s.name}: ${join(this.paths(key).engine, prefix, s.directory, 'SKILL.md')}`));
        Object.assign(files, nativeWorkspaceSkillFiles(this.options.engineId, b));
      }
      const entry = entries.join('\n');
      files['workspace/AGENTS.md'] = common.length
        ? '# Workspace navigation\nRead .aria/space-guide.md for the deployment common layer and project entry.\nRead .aria/skills.md only for a matching task; public tools do not grant access to other Spaces.\n'
        : entry;
      files['workspace/.aria/space-guide.md'] = entry;
      files['workspace/.aria/resources.json'] = JSON.stringify({ schema: 'aria.workspace.resources.v1', resources: bundles.flatMap(b => b.resources) }, null, 2) + '\n';
      files['workspace/.aria/skills.md'] = '# Skills\nRead the matching SKILL.md only when needed.\n'
        + skills.join('\n') + '\n';
    }
    return { files, ...(bundle ? { bundle } : {}), bundles, common, selection,
      revision: digest(JSON.stringify([common.length ? bundles : bundle ?? null, this.options.engineId])) };
  }
  private targetAllowed(path: string): boolean {
    if (!workspaceRelativePath(path)) return false;
    return ['workspace/AGENTS.md', 'workspace/.aria/space-guide.md', 'workspace/.aria/resources.json', 'workspace/.aria/skills.md'].includes(path)
      || path.startsWith('workspace/.aria/business/')
      || path.startsWith('workspace/.aria/common/')
      || (this.options.engineId === 'codex' && /^home\/\.codex\/skills\/[a-z0-9][a-z0-9_-]{0,63}\//.test(path));
  }
  private async current(paths: SpacePaths, path: string): Promise<string | null> {
    if (!this.targetAllowed(path)) throw new Error('invalid managed workspace target');
    const absolute = await assertConfinedPath(paths.engine, join(paths.engine, path));
    let handle;
    try {
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024 || stat.nlink !== 1) throw new Error('invalid managed workspace file');
      return await handle.readFile('utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
  private async receipt(paths: SpacePaths): Promise<Receipt | undefined> {
    let v: Receipt;
    try { v = await readPrivateJson(join(paths.control, 'workspace-setup.json'), paths.control, 48 * 1024 * 1024) as Receipt; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    this.validateReceipt(paths, v);
    return v;
  }
  private validateReceipt(paths: SpacePaths, v: Receipt): void {
    if (!v || v.schema !== 'aria.workspace.receipt.v1' || v.spaceId !== paths.spaceId || !/^[a-f0-9]{64}$/.test(v.revision)
      || !v.files || typeof v.files !== 'object' || Array.isArray(v.files) || Object.keys(v.files).length > 1024
      || Object.entries(v.files).some(([path, hash]) => !this.targetAllowed(path) || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('invalid workspace receipt');
    if (v.baseline !== undefined && (!v.baseline || typeof v.baseline !== 'object' || Array.isArray(v.baseline)
      || Object.entries(v.baseline).some(([path, contents]) => !v.files[path] || typeof contents !== 'string' || Buffer.byteLength(contents) > 1024 * 1024))) {
      throw new Error('invalid workspace baseline');
    }
  }
  private async journal(paths: SpacePaths): Promise<Journal | undefined> {
    let v: Journal;
    try { v = await readPrivateJson(join(paths.control, 'workspace-update.json'), paths.control, 96 * 1024 * 1024) as Journal; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    this.validateReceipt(paths, v?.receipt);
    if (v.schema !== 'aria.workspace.journal.v1' || !Array.isArray(v.changes) || v.changes.length > 1024
      || new Set(v.changes.map(c => c.path)).size !== v.changes.length
      || v.changes.some(c => !this.targetAllowed(c.path) || (c.before !== null && typeof c.before !== 'string')
        || (c.after !== null && (typeof c.after !== 'string' || (v.receipt.files[c.path] !== undefined && digest(c.after) !== v.receipt.files[c.path])))
        || (c.after === null && v.receipt.files[c.path] !== undefined))) throw new Error('invalid workspace journal');
    return v;
  }
  private async compare(paths: SpacePaths, desired: Desired) {
    const before = await this.receipt(paths), pending = await this.journal(paths);
    const changes: Change[] = [], conflicts: string[] = [], owned: Record<string, string> = {}, baseline: Record<string, string> = {};
    let preservedAgents = false;
    for (const path of [...new Set([...Object.keys(before?.files ?? {}), ...Object.keys(desired.files)])].sort()) {
      const current = await this.current(paths, path), managed = desired.files[path] !== undefined;
      const next = managed ? desired.files[path]! : before?.baseline?.[path] ?? null;
      const previousHash = before?.files[path];
      if (current !== null && current !== next && (!previousHash || digest(current) !== previousHash)) {
        if (path === 'workspace/AGENTS.md') { preservedAgents = true; continue; }
        // A user may add a local skill to the generated navigation index.
        // Keep the entire file user-owned when every requested managed entry
        // is still present verbatim. Never repair an edited/removed entry.
        if (path === 'workspace/.aria/skills.md' && managed && next !== null
          && next.split('\n').filter(Boolean).every(line => current.split('\n').includes(line))) continue;
        conflicts.push(path); continue;
      }
      if (managed) {
        owned[path] = digest(next!);
        if (before?.baseline?.[path] !== undefined) baseline[path] = before.baseline[path]!;
        else if (!previousHash && current !== null) baseline[path] = current;
      }
      if (current !== next) changes.push({ path, before: current, after: next });
    }
    const resources = await Promise.all(desired.bundles.flatMap(b => b.resources).map(async r => {
      try {
        await assertConfinedPath('/', r.path);
        if (this.options.driver !== 'trusted-process' && !within(paths.engine, r.path)
          && !(this.options.driver === 'execution' && this.options.readonlyResources?.some(root => within(root, r.path)))) throw new Error('resource is not visible under selected driver');
        await access(r.path, constants.R_OK);
        return { name: r.name, available: true };
      } catch { return { name: r.name, available: false }; }
    }));
    const requiredTools = [...new Map(desired.bundles.flatMap(b => b.requiresTools ?? []).map(t => [t.id, t])).values()]
      .map(t => ({ ...t, available: this.options.availableTools?.some(a => a.id === t.id && a.revision === t.revision) === true }));
    const status: WorkspaceSetupPlan['status'] = pending ? 'recovery-required' : conflicts.length || resources.some(r => !r.available) || requiredTools.some(t => !t.available) ? 'conflict'
      : changes.length || (before && before.revision !== desired.revision) || (desired.bundles.length && !before) ? 'pending'
        : desired.bundles.length ? 'ready' : 'unassigned';
    const plan: WorkspaceSetupPlan = { status, selection: desired.selection, delivery: workspaceSkillDelivery(this.options.engineId),
      ...(desired.bundle ? { bundle: desired.bundle.id, revision: desired.bundle.revision } : {}),
      ...(desired.common.length ? { common: desired.common.map(b => ({ id: b.id, revision: b.revision })) } : {}),
      ...(requiredTools.length ? { requiredTools } : {}),
      changes: changes.map(c => ({ path: c.path, action: c.after === null ? 'remove' : c.before === null ? 'create' : 'update' })),
      conflicts, preservedAgents, resources, discovery: 'not-checked' };
    try {
      const discovery = await readPrivateJson(join(paths.control, 'workspace-discovery.json'), paths.control) as { revision: string; delivery: string };
      if (status === 'ready' && discovery.revision === desired.revision && discovery.delivery === plan.delivery) {
        plan.discovery = plan.delivery === 'native-codex' ? 'native-verified' : 'explicit-catalog';
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const receipt: Receipt = { schema: 'aria.workspace.receipt.v1', spaceId: paths.spaceId, revision: desired.revision,
      ...(desired.bundle ? { bundle: desired.bundle.id } : {}), files: owned, baseline, preservedAgents };
    return { plan, changes, receipt };
  }
  private async reconcile(key: SpaceKey): Promise<void> {
    const paths = this.paths(key), desired = this.desired(key);
    const pending = await this.journal(paths);
    if (pending) await this.finish(paths, pending);
    const { plan, changes, receipt } = await this.compare(paths, desired);
    if (plan.status === 'conflict') throw new Error('workspace setup conflict; inspect workspace plan before retrying');
    if (plan.status === 'unassigned' || plan.status === 'ready') return;
    await prepareSpacePaths(paths);
    const update: Journal = { schema: 'aria.workspace.journal.v1', receipt, changes };
    await this.atomic(paths.control, join(paths.control, 'workspace-update.json'), JSON.stringify(update));
    await this.finish(paths, update);
  }
  private async finish(paths: SpacePaths, update: Journal): Promise<void> {
    // Check the entire interrupted transaction before completing any of it.
    for (const c of update.changes) {
      const current = await this.current(paths, c.path);
      if (current !== c.before && current !== c.after) throw new Error('workspace recovery conflict; local edits were preserved');
    }
    for (const c of update.changes) {
      const current = await this.current(paths, c.path);
      if (current === c.after) continue;
      if (current !== c.before) throw new Error('workspace changed during update');
      const target = await assertConfinedPath(paths.engine, join(paths.engine, c.path));
      if (c.after === null) await unlink(target);
      else await this.atomic(paths.engine, target, c.after);
    }
    await this.atomic(paths.control, join(paths.control, 'workspace-revisions', update.receipt.revision + '.json'), JSON.stringify(update.receipt));
    await this.atomic(paths.control, join(paths.control, 'workspace-setup.json'), JSON.stringify(update.receipt));
    await unlink(await assertConfinedPath(paths.control, join(paths.control, 'workspace-update.json')));
  }
  private async atomic(root: string, file: string, contents: string): Promise<void> {
    await assertConfinedPath(root, file); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      await writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
      await assertConfinedPath(root, file); await rename(temp, file);
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
