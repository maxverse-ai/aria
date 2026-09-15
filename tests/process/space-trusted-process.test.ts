import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { normalizeEngineProfileConfig } from '../../src/config/profile-schema';
import { createSpaceEngineRuntime, SPACE_ENGINE_IDS } from '../../src/space/engine-runtime';
import { resolveSpacePaths } from '../../src/space/paths';
import { confineSpawn, withConfinedLaunch } from '../../src/space/launch';
import { runtimeQueries } from '../../src/agent/runtime/queries';
import { spaceEngineMain } from '../helpers/space-engine';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it.each(SPACE_ENGINE_IDS)('%s trusted process: explicit shared host, independent native state and one query owner', async (engineId) => {
  const root = await mkdtemp(join(tmpdir(), 'aria-space-trusted-')); roots.push(root);
  const bin = join(root, 'bin'); await mkdir(bin);
  const binary = join(bin, engineId), sentinel = join(root, 'host-visible-fixture');
  await writeFile(sentinel, 'no OS isolation claimed');
  await writeFile(binary, '#!' + process.execPath + '\n(' + spaceEngineMain.toString() + ')('
    + JSON.stringify({ engine: engineId, envKeys: ['HOME', 'CODEX_HOME', 'XDG_STATE_HOME', 'LARK_CHANNEL_CONFIG'], sentinelPath: sentinel }) + ');\n', { mode: 0o755 });
  const profile = normalizeEngineProfileConfig({ schemaVersion: 2, mode: 'team', agentKind: engineId,
    ...(engineId === 'claude' ? {} : { [engineId]: { binaryPath: binary } }),
    permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' } });
  const spaces = ['a', 'b'].map((subjectId) => resolveSpacePaths(root, { kind: 'user', profileId: 'p',
    principal: { profileId: 'p', authorityId: 'account', kind: 'user', subjectId } }));
  const runtimes = await Promise.all(spaces.map((paths) => createSpaceEngineRuntime({ profile, paths,
    deployment: { engineId, binary, binaryVersion: 'fixture', launch: {
      driver: 'trusted-process', environment: {}, executableRoots: [bin], workspaceAccess: 'workspace' } } })));
  try {
    await Promise.all(runtimes.map(async (runtime, index) => {
      const paths = spaces[index]!;
      const run = runtime.execution.run({ runId: 'run-' + index, scopeId: 'scope-' + index,
        cwd: paths.workspace, prompt: 'hello', sandbox: 'workspace-write', permissionMode: 'acceptEdits' });
      const events = [];
      for await (const event of run.events) events.push(event);
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({ type: 'done', terminationReason: 'normal' }));
      expect(await run.waitForExit(1000)).toBe(true);
      if (['codex', 'grok'].includes(engineId)) {
        await runtimeQueries(runtime).listHistory!({ cwd: paths.workspace, limit: 5 });
        expect((await readFile(join(paths.state, 'spawns'), 'utf8')).trim().split('\n')).toHaveLength(1);
      }
      const record = JSON.parse(await readFile(join(paths.state, 'launch.json'), 'utf8'));
      expect(record.hostReadable).toBe(true);
      expect(record.env.HOME).toBe(paths.home);
      expect(record.env.XDG_STATE_HOME).toBe(paths.state);
      expect(record.env.LARK_CHANNEL_CONFIG).toBeUndefined();
    }));
  } finally { await Promise.all(runtimes.map((runtime) => runtime.dispose())); }
}, 20_000);

it('an undeclared driver never selects trusted execution', () => {
  const paths = resolveSpacePaths('/tmp/aria-launch-fixture', { kind: 'default', profileId: 'p' });
  expect(() => withConfinedLaunch({ binary: process.execPath, paths, executableRoots: [], environment: {}, workspaceAccess: 'workspace' },
    () => confineSpawn(process.execPath, [], {}))).toThrow('explicit supported isolation driver');
});
