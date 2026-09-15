import { isAbsolute, posix } from 'node:path';
import { digest, readPrivateJson } from './deployment';
import { requiredId, spaceId, type SpaceKey } from './identity';
import { validateToolExtension, type SpaceToolExtensionDefinition } from './tool-extension';

export interface WorkspaceFile { path: string; contents: string; sha256: string }
export interface WorkspaceBundle {
  id: string;
  revision: string;
  /** Business-owned short entry, relative to files. Detailed rules stay in other files. */
  entry: string;
  files: readonly WorkspaceFile[];
  skills: readonly { name: string; directory: string }[];
  /** Describes deployment-admitted resources; this declaration does not mount or grant them. */
  resources: readonly { name: string; path: string; access: 'read-only' }[];
  /** Exact host tool revisions. Installing instructions never grants credentials. */
  requiresTools?: readonly { id: string; revision: string }[];
}
export interface SpaceWorkspacesDefinition {
  schema: 'aria.space.workspaces.v1';
  bundles: readonly WorkspaceBundle[];
  /** An explicit null assignment opts a Space out of its matching default. */
  assignments: readonly { space: SpaceKey; bundle: string | null }[];
  /** Deployment opt-in for already-admitted Spaces from one identity authority. */
  defaults?: readonly { kind: 'user' | 'shared'; authorityId: string; bundle: string }[];
  /** Additive deployment baseline; business assignment/opt-out does not remove it. */
  common?: readonly { kind: 'user' | 'shared'; authorityId: string; bundles: readonly string[] }[];
  /** Host-installed adapters shipped with this capability definition, not with
   * an immutable native-history preparation. Apply under stopped-profile lock. */
  extensions?: readonly SpaceToolExtensionDefinition[];
}
export const EMPTY_SPACE_WORKSPACES: SpaceWorkspacesDefinition = { schema: 'aria.space.workspaces.v1', bundles: [], assignments: [] };
const name = (value: unknown) => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
function object(value: unknown, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('invalid workspace definition field');
}
export function workspaceRelativePath(value: string): boolean {
  return typeof value === 'string' && value.length <= 240 && !isAbsolute(value)
    && value.split('/').every(p => /^[a-zA-Z0-9_.-]+$/.test(p) && p !== '.' && p !== '..' && p !== '.git')
    && posix.normalize(value) === value;
}
export function normalizeSpaceWorkspaces(value: unknown, profileId: string): SpaceWorkspacesDefinition {
  object(value, ['schema', 'bundles', 'assignments', 'defaults', 'common', 'extensions']);
  const v = value as unknown as SpaceWorkspacesDefinition;
  if (v.schema !== 'aria.space.workspaces.v1' || !Array.isArray(v.bundles) || v.bundles.length > 64
    || !Array.isArray(v.assignments) || v.assignments.length > 4096) throw new Error('invalid workspace definition');
  const ids = new Set<string>(); let bytes = 0;
  for (const b of v.bundles) {
    object(b, ['id', 'revision', 'entry', 'files', 'skills', 'resources', 'requiresTools']);
    if (!name(b.id) || ids.has(b.id) || typeof b.revision !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(b.revision)
      || !workspaceRelativePath(b.entry) || !Array.isArray(b.files) || b.files.length > 256
      || !Array.isArray(b.skills) || b.skills.length > 64 || !Array.isArray(b.resources) || b.resources.length > 64) throw new Error('invalid workspace bundle');
    ids.add(b.id);
    const files = new Set<string>();
    for (const f of b.files) {
      object(f, ['path', 'contents', 'sha256']);
      if (!workspaceRelativePath(f.path) || files.has(f.path) || typeof f.contents !== 'string'
        || Buffer.byteLength(f.contents) > 1024 * 1024 || f.contents.includes('\0') || digest(f.contents) !== f.sha256) throw new Error('invalid workspace asset');
      files.add(f.path); bytes += Buffer.byteLength(f.contents);
    }
    const entry = b.files.find((f: WorkspaceFile) => f.path === b.entry);
    if (!entry || entry.contents.trim().split('\n').length > 20 || Buffer.byteLength(entry.contents) > 2048) throw new Error('workspace navigation must fit 20 lines and 2048 bytes');
    const skills = new Set<string>();
    for (const s of b.skills) {
      object(s, ['name', 'directory']);
      if (!name(s.name) || skills.has(s.name) || !workspaceRelativePath(s.directory) || !files.has(s.directory + '/SKILL.md')) throw new Error('invalid workspace skill');
      skills.add(s.name);
    }
    const resources = new Set<string>();
    for (const r of b.resources) {
      object(r, ['name', 'path', 'access']);
      if (!name(r.name) || resources.has(r.name) || typeof r.path !== 'string' || !isAbsolute(r.path)
        || /[\u0000-\u001f]/.test(r.path) || r.path.length > 4096 || r.access !== 'read-only') throw new Error('invalid workspace resource');
      resources.add(r.name);
    }
    if (b.requiresTools !== undefined) {
      if (!Array.isArray(b.requiresTools) || b.requiresTools.length > 16) throw new Error('invalid workspace tool requirements');
      const tools = new Set<string>();
      for (const tool of b.requiresTools) {
        object(tool, ['id', 'revision']);
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(tool.id) || tools.has(tool.id)
          || typeof tool.revision !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.revision)) throw new Error('invalid workspace tool requirement');
        tools.add(tool.id);
      }
    }
  }
  if (bytes > 8 * 1024 * 1024) throw new Error('workspace assets exceed size limit');
  if (v.extensions !== undefined) {
    if (!Array.isArray(v.extensions) || v.extensions.length > 16) throw new Error('invalid workspace extensions');
    const names = new Set<string>();
    for (const extension of v.extensions) {
      validateToolExtension(extension);
      if (names.has(extension.id)) throw new Error('duplicate workspace extension');
      names.add(extension.id);
    }
  }
  const spaces = new Set<string>();
  for (const a of v.assignments) {
    object(a, ['space', 'bundle']);
    object(a.space, ['kind', 'profileId', 'principal', 'authorityId', 'trustDomain']);
    if (a.space.profileId !== profileId || (a.bundle !== null && !ids.has(a.bundle))) throw new Error('workspace assignment has no matching profile or bundle');
    const id = spaceId(a.space);
    if (spaces.has(id)) throw new Error('duplicate workspace assignment');
    spaces.add(id);
  }
  if (v.defaults !== undefined) {
    if (!Array.isArray(v.defaults) || v.defaults.length > 256) throw new Error('invalid workspace defaults');
    const selectors = new Set<string>();
    for (const rule of v.defaults) {
      object(rule, ['kind', 'authorityId', 'bundle']);
      if (!['user', 'shared'].includes(rule.kind) || !ids.has(rule.bundle)) throw new Error('invalid workspace default');
      requiredId(rule.authorityId, 'workspace authority');
      const selector = JSON.stringify([rule.kind, rule.authorityId]);
      if (selectors.has(selector)) throw new Error('duplicate workspace default');
      selectors.add(selector);
    }
  }
  if (v.common !== undefined) {
    if (!Array.isArray(v.common) || v.common.length > 256) throw new Error('invalid common workspace rules');
    const selectors = new Set<string>();
    for (const rule of v.common) {
      object(rule, ['kind', 'authorityId', 'bundles']);
      requiredId(rule.authorityId, 'workspace authority');
      const selector = JSON.stringify([rule.kind, rule.authorityId]);
      if (!['user', 'shared'].includes(rule.kind) || selectors.has(selector) || !Array.isArray(rule.bundles)
        || rule.bundles.length > 16 || new Set(rule.bundles).size !== rule.bundles.length
        || rule.bundles.some((id: unknown) => typeof id !== 'string' || !ids.has(id))) throw new Error('invalid common workspace rule');
      selectors.add(selector);
      // Reject ambiguous native skill/resource ownership before any Space write.
      const common = v.bundles.filter(b => rule.bundles.includes(b.id));
      assertWorkspaceComposition(common);
      const businessIds = [
        ...v.defaults?.filter(r => r.kind === rule.kind && r.authorityId === rule.authorityId).map(r => r.bundle) ?? [],
        ...v.assignments.filter(a => a.space.kind === rule.kind
          && (a.space.kind === 'user' ? a.space.principal.authorityId : a.space.kind === 'shared' ? a.space.authorityId : undefined) === rule.authorityId).map(a => a.bundle),
      ];
      for (const b of v.bundles.filter(b => businessIds.includes(b.id))) assertWorkspaceComposition([...common, b]);
    }
  }
  return structuredClone(v);
}

/** Selection describes resources; admission and filesystem access keep their
 * original owners. Exact assignments (including opt-out) always win. */
export function selectWorkspaceBundle(definition: SpaceWorkspacesDefinition, key: SpaceKey) {
  const assignment = definition.assignments.find(a => spaceId(a.space) === spaceId(key));
  const authority = key.kind === 'user' ? key.principal.authorityId : key.kind === 'shared' ? key.authorityId : undefined;
  const fallback = !assignment && definition.defaults?.find(r => r.kind === key.kind && r.authorityId === authority);
  const bundleId = assignment ? assignment.bundle : fallback ? fallback.bundle : undefined;
  return { bundle: definition.bundles.find(b => b.id === bundleId),
    selection: assignment ? 'explicit' as const : fallback ? 'default' as const : 'none' as const };
}

/** Public assets are selected only within an explicitly admitted authority.
 * Unknown/default Spaces do not inherit an ambient machine-wide account. */
export function selectWorkspaceLayers(definition: SpaceWorkspacesDefinition, key: SpaceKey) {
  const selected = selectWorkspaceBundle(definition, key);
  const authority = key.kind === 'user' ? key.principal.authorityId : key.kind === 'shared' ? key.authorityId : undefined;
  const rule = definition.common?.find(r => r.kind === key.kind && r.authorityId === authority);
  const common = (rule?.bundles ?? []).map(id => definition.bundles.find(b => b.id === id)!);
  const bundles = [...common, ...(selected.bundle && !common.some(b => b.id === selected.bundle!.id) ? [selected.bundle] : [])];
  assertWorkspaceComposition(bundles);
  return { ...selected, common, bundles };
}

function assertWorkspaceComposition(input: readonly WorkspaceBundle[]): void {
  const bundles = [...new Map(input.map(b => [b.id, b])).values()];
  const skills = new Set<string>(), resources = new Set<string>(), tools = new Map<string, string>();
  let files = 4;
  for (const b of bundles) {
    files += b.files.length * 2;
    for (const s of b.skills) {
      if (skills.has(s.name)) throw new Error('workspace layers have conflicting skill names');
      skills.add(s.name);
    }
    for (const r of b.resources) {
      if (resources.has(r.name)) throw new Error('workspace layers have conflicting resource names');
      resources.add(r.name);
    }
    for (const tool of b.requiresTools ?? []) {
      if (tools.has(tool.id) && tools.get(tool.id) !== tool.revision) throw new Error('workspace layers have conflicting tool revisions');
      tools.set(tool.id, tool.revision);
    }
  }
  if (files > 1024 || skills.size > 64) throw new Error('workspace composition exceeds managed asset limits');
}

/** Independent of the sealed execution preparation. Reload only after the host
 * has drained and restarted the profile; running tasks retain their snapshot. */
export async function readSpaceWorkspaces(file: string, profileId: string): Promise<SpaceWorkspacesDefinition> {
  try { return normalizeSpaceWorkspaces(await readPrivateJson(file), profileId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY_SPACE_WORKSPACES); throw error; }
}
