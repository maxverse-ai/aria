import { join } from 'node:path';
import type { WorkspaceBundle } from '../../space/workspace-definition';
import { startCodexAppServer } from '../engines/codex/app-server/process';

/** Native discovery paths are engine-owned. Engines without a verified native
 * installer receive the same explicit, lazy skill catalog through run context. */
export function workspaceSkillDelivery(engineId: string): 'native-codex' | 'explicit-catalog' {
  return engineId === 'codex' ? 'native-codex' : 'explicit-catalog';
}
export function nativeWorkspaceSkillFiles(engineId: string, bundle: WorkspaceBundle): Record<string, string> {
  const files: Record<string, string> = {};
  if (workspaceSkillDelivery(engineId) !== 'native-codex') return files;
  for (const skill of bundle.skills) {
    for (const file of bundle.files) {
      if (file.path.startsWith(skill.directory + '/')) files[join('home', '.codex', 'skills', skill.name, file.path.slice(skill.directory.length + 1))] = file.contents;
    }
  }
  return files;
}

/** Metadata-only native discovery: no thread creation, model turn or tool call. */
export async function verifyWorkspaceSkillCatalog(input: {
  engineId: string; binary: string; cwd: string; home: string; state: string;
  skills: readonly string[]; signal?: AbortSignal;
}): Promise<void> {
  if (workspaceSkillDelivery(input.engineId) !== 'native-codex' || input.skills.length === 0) return;
  input.signal?.throwIfAborted();
  const client = await startCodexAppServer({ binary: input.binary, cwd: input.cwd,
    codexHome: join(input.home, '.codex'), inheritCodexHome: false, profileStateDir: input.state });
  try {
    input.signal?.throwIfAborted();
    const result = await client.request<{ data: { cwd: string; skills: { name: string; path: string; enabled: boolean }[]; errors: unknown[] }[] }>(
      'skills/list', { cwds: [input.cwd], forceReload: true }, 10_000, input.signal);
    const scope = result.data?.find(d => d.cwd === input.cwd);
    if (!scope || !Array.isArray(scope.skills) || scope.errors?.length || input.skills.some(name => !scope.skills.some(s =>
      s.name === name && s.enabled && s.path === join(input.home, '.codex', 'skills', name, 'SKILL.md')))) {
      throw new Error('workspace native skills were not discovered');
    }
  } finally { await client.dispose(); }
}
