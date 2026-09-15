import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from './deployment';
import { assertConfinedPath } from './paths';
import type { SpaceOperationGate } from './operation-gate';
import type { SpaceToolCredentials } from './tool-credentials';
import type { SpaceNativeTool } from './native-tools';

/** Operator-owned code, pinned with the deployment, never an agent-selected plugin. */
export interface SpaceToolExtensionDefinition {
  id: string;
  revision: string;
  module: string;
  sha256: string;
}
export interface SpaceToolExtensionHost {
  readonly authorityId: string;
  readonly profileId: string;
  /** Host control directory, not an agent workspace. Never return it to the model. */
  readonly directory: string;
  readonly credentials: SpaceToolCredentials;
  /** Capture the originating gate inside invoke; never cache a "current user". */
  activeGate(): SpaceOperationGate;
}
export interface SpaceToolExtensionModule {
  spaceToolRevision: string;
  createSpaceTool(host: SpaceToolExtensionHost): Promise<SpaceNativeTool> | SpaceNativeTool;
}

export function validateToolExtension(v: SpaceToolExtensionDefinition): void {
  if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['id', 'revision', 'module', 'sha256'].includes(k))
    || typeof v.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(v.id) || v.id === 'lark-cli'
    || typeof v.revision !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(v.revision)
    || typeof v.module !== 'string' || !isAbsolute(v.module) || !v.module.endsWith('.mjs')
    || /[\u0000-\u001f]/.test(v.module) || !/^[a-f0-9]{64}$/.test(v.sha256)) throw new Error('invalid native tool extension');
}

/** Integrity check before import. Dependencies must also be pinned by the
 * immutable deployment artifact; this is not a sandbox for untrusted code. */
export async function loadSpaceToolExtension(definition: SpaceToolExtensionDefinition, host: SpaceToolExtensionHost): Promise<SpaceNativeTool> {
  validateToolExtension(definition);
  await assertConfinedPath(parse(definition.module).root, definition.module);
  const handle = await open(definition.module, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o022)
      || digest(await handle.readFile()) !== definition.sha256) throw new Error('native tool extension integrity check failed');
  } finally { await handle.close(); }
  const url = pathToFileURL(definition.module); url.searchParams.set('revision', definition.sha256);
  const module = await import(url.href) as SpaceToolExtensionModule;
  if (module.spaceToolRevision !== definition.revision || typeof module.createSpaceTool !== 'function') {
    throw new Error('native tool extension contract or revision mismatch');
  }
  const tool = await module.createSpaceTool(Object.freeze({ ...host }));
  if (!tool || tool.id !== definition.id || tool.authorityId !== host.authorityId
    || typeof tool.invoke !== 'function' || typeof tool.description !== 'string' || tool.description.length > 4096
    || (tool.close !== undefined && typeof tool.close !== 'function')
    || (tool.activeWork !== undefined && typeof tool.activeWork !== 'function')) {
    if (typeof tool?.close === 'function') await tool.close();
    throw new Error('native tool extension returned an invalid adapter');
  }
  return tool;
}
