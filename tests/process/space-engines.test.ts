import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeEngineProfileConfig } from '../../src/config/profile-schema';
import { createSpaceEngineRuntime, SPACE_ENGINE_IDS } from '../../src/space/engine-runtime';
import { resolveSpacePaths } from '../../src/space/paths';
import { runtimeQueries } from '../../src/agent/runtime/queries';
import { spaceEngineMain } from '../helpers/space-engine';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
describe('isolated native engine processes', () => {
  for (const access of ['workspace', 'read-only'] as const) it.runIf(process.platform === 'linux').each(SPACE_ENGINE_IDS)('%s/' + access + ': separate homes/state and no inherited host files; daemon queries retain one owner', async (engineId) => {
    const root = await mkdtemp(join(tmpdir(), 'aria-space-native-')); roots.push(root);
    const bin = join(root, 'bin'); await mkdir(bin);
    const binary = join(bin, engineId);
    const sentinel = join(root, 'operator-token'); await writeFile(sentinel, 'fixture-only');
    const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'GROK_HOME', 'DSH_HOME', 'LARK_CHANNEL_CONFIG', 'LARKSUITE_CLI_CONFIG_DIR'];
    await writeFile(binary, '#!' + process.execPath + '\n(' + spaceEngineMain.toString() + ')('
      + JSON.stringify({ engine: engineId, envKeys, sentinelPath: sentinel }) + ');\n', { mode: 0o755 });
    const profile = normalizeEngineProfileConfig({ schemaVersion: 2, mode: 'team', agentKind: engineId,
      ...(engineId === 'claude' ? {} : { [engineId]: { binaryPath: binary } }),
      permissions: { defaultAccess: access, maxAccess: access } });
    const paths = ['a', 'b'].map((subjectId) => resolveSpacePaths(root, { kind: 'user', profileId: 'p',
      principal: { profileId: 'p', authorityId: 'test-account', kind: 'user', subjectId } }));
    const runtimes = await Promise.all(paths.map((space) => createSpaceEngineRuntime({ profile, paths: space,
      deployment: { engineId, binary, binaryVersion: 'fixture-1', launch: {
        bubblewrap: '/usr/bin/bwrap', executableRoots: [bin, dirname(dirname(process.execPath))],
        environment: {}, workspaceAccess: access } } })));
    try {
      await Promise.all(runtimes.map(async (runtime, index) => {
        const run = runtime.execution.run({ runId: 'run-' + index, scopeId: 'scope-' + index,
          cwd: paths[index]!.workspace, prompt: 'hello', sandbox: access === 'read-only' ? 'read-only' : 'workspace-write', permissionMode: access === 'read-only' ? 'plan' : 'acceptEdits' });
        const events = [];
        for await (const event of run.events) events.push(event);
        expect(events.filter((event) => event.type === 'error')).toEqual([]);
        expect(events).toContainEqual(expect.objectContaining({ type: 'done', terminationReason: 'normal' }));
        expect(await run.waitForExit(1000)).toBe(true);
        if (['codex', 'grok'].includes(engineId)) {
          await runtimeQueries(runtime).listHistory!({ cwd: paths[index]!.workspace, limit: 5 });
          const launches = (await readFile(join(paths[index]!.state, 'spawns'), 'utf8')).trim().split('\n');
          expect(launches).toHaveLength(1);
        }
        const record = JSON.parse(await readFile(join(paths[index]!.state, 'launch.json'), 'utf8'));
        expect(record.hostReadable).toBe(false);
        expect(record.workspaceWritable).toBe(access === 'workspace');
        expect(record.env.HOME).toBe(paths[index]!.home);
        expect(record.env.XDG_STATE_HOME).toBe(paths[index]!.state);
        expect(record.env.LARK_CHANNEL_CONFIG).toBeUndefined();
        expect(record.env.LARKSUITE_CLI_CONFIG_DIR).toBeUndefined();
      }));
    } finally { await Promise.all(runtimes.map((runtime) => runtime.dispose())); }
  }, 20_000);
});
