import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '../../../src/space/deployment';
import { nodeHelperBinary, runtimeProbeVersion } from '../../helpers/runtime';
import { loadSpaceToolExtension, type SpaceToolExtensionHost } from '../../../src/space/tool-extension';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(source = `export const spaceToolRevision = 'v1';
export function createSpaceTool(host) { return { id: 'example', authorityId: host.authorityId, description: 'Example tool',
  async invoke(operation) { return {stdout: host.activeGate().active().request.senderId, stderr: '', exitCode: 0}; } }; }`) {
  const root = await mkdtemp(join(tmpdir(), 'aria-extension-')); roots.push(root);
  const module = join(root, 'adapter.mjs'); await writeFile(module, source, { mode: 0o600 });
  const host = { authorityId: 'a'.repeat(64), profileId: 'profile', directory: root, credentials: {},
    activeGate: vi.fn(() => ({ active: () => ({ request: { senderId: 'current-user' } }) })) } as unknown as SpaceToolExtensionHost;
  return { root, host, definition: { id: 'example', revision: 'v1', module, sha256: digest(source) } };
}
it('loads the pinned host adapter without credentials in its declaration and resolves the current actor only on invocation', async () => {
  const f = await fixture(), tool = await loadSpaceToolExtension(f.definition, f.host);
  expect(f.host.activeGate).not.toHaveBeenCalled();
  expect((await tool.invoke({} as never, {} as never)).stdout).toBe('current-user');
});
it('refuses tampered, writable, symlinked and wrong-version extensions', async () => {
  const f = await fixture();
  await expect(loadSpaceToolExtension({ ...f.definition, sha256: '0'.repeat(64) }, f.host)).rejects.toThrow('integrity');
  await expect(loadSpaceToolExtension({ ...f.definition, revision: 'v2' }, f.host)).rejects.toThrow('revision');
  await chmod(f.definition.module, 0o666);
  await expect(loadSpaceToolExtension(f.definition, f.host)).rejects.toThrow('integrity');
  const link = join(f.root, 'link.mjs'); await symlink(f.definition.module, link);
  await expect(loadSpaceToolExtension({ ...f.definition, module: link }, f.host)).rejects.toThrow('symlink');
});
it('refuses a factory that returns another tool or authority', async () => {
  const f = await fixture(`export const spaceToolRevision='v1'; export function createSpaceTool(host) {
    return {id:'wrong', authorityId:host.authorityId, description:'Bad', async invoke(){}}; }`);
  await expect(loadSpaceToolExtension(f.definition, f.host)).rejects.toThrow('invalid adapter');
});


it('prepares workspace extension transport without enabling Lark user authorization', async () => {
  const { PreparedSpaceProfile } = await import('../../../src/space/profile');
  const { createDefaultProfileConfig } = await import('../../../src/config/profile-schema');
  const { spaceEngineCapabilities } = await import('../../../src/space/capabilities');
  const f = await fixture();
  const profile = createDefaultProfileConfig({ agentKind: 'codex', mode: 'team', codex: { binaryPath: process.execPath },
    accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } } });
  for (const driver of ['trusted-process', 'execution'] as const) {
    const deployment = { engineId: 'codex' as const, binary: process.execPath, binaryVersion: runtimeProbeVersion,
      queryNode: nodeHelperBinary, launch: { driver, workspaceAccess: 'workspace' as const, executableRoots: [], environment: {} } };
    const input = { profileId: 'profile', profile, directory: join(f.root, driver), deployment,
      workspaces: { schema: 'aria.space.workspaces.v1' as const, bundles: [], assignments: [], extensions: [f.definition] } };
    const prepared = await PreparedSpaceProfile.create(input);
    try {
      expect(prepared.nativeTools).toBeDefined();
      expect(prepared.toolDeployment).toBeUndefined();
      expect(spaceEngineCapabilities('codex', deployment).userToolAuthorization).toBe(false);
      expect(await prepared.workspaces.prepareExisting()).toEqual([]);
    } finally { await prepared.services.close(); }
    await expect(PreparedSpaceProfile.create({ ...input, deployment: { ...deployment, queryNode: undefined } }))
      .rejects.toThrow('prepared native tool transport');
  }
});
