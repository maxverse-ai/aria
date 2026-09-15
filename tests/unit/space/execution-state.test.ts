import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { normalizeEngineProfileConfig } from '../../../src/config/profile-schema';
import { createSpaceEngineRuntime } from '../../../src/space/engine-runtime';
import { resolveSpacePaths } from '../../../src/space/paths';
import { runtimeQueries } from '../../../src/agent/runtime/queries';
import type { ExecutionBackend } from '../../../src/execution/types';
import { spaceEngineMain } from '../../helpers/space-engine';

it.each(['execution', 'trusted-process'] as const)('%s daemon preserves its state boundary and history owner', async driver => {
  const root = await mkdtemp(join(tmpdir(), 'aria-execution-state-'));
  let closes = 0;
  try {
    const bin = join(root, 'bin'); await mkdir(bin);
    const binary = join(bin, 'codex');
    const cwdLog = join(root, 'cwd-log');
    await writeFile(binary, '#!' + process.execPath + '\nrequire("fs").appendFileSync(' + JSON.stringify(cwdLog) + ', process.cwd() + "\\n");\n(' + spaceEngineMain.toString() + ')('
      + JSON.stringify({ engine: 'codex', envKeys: ['XDG_STATE_HOME'], sentinelPath: join(root, 'absent') }) + ');\n', { mode: 0o755 });
    const paths = resolveSpacePaths(root, { kind: 'default', profileId: 'p' });
    const resources = join(root, 'reference'); await mkdir(resources);
    const commands: string[] = [];
    const backend: ExecutionBackend = { id: 'fixture', async open(spec) {
      expect(spec.workingRoots).not.toContain(paths.engine);
      expect(spec.mounts).toContainEqual({ source: resources, target: resources, writable: false });
      expect(spec.workingRoots).not.toContain(resources);
      return { id: 'fixture', prepare(request) {
        if (!spec.workingRoots.some(p => request.cwd === p || request.cwd.startsWith(p + '/'))) {
          throw new Error('execution command escapes its Space');
        }
        commands.push(request.cwd);
        return { command: request.command, args: request.args, cwd: request.cwd, env: { ...request.env } };
      }, async close() { closes++; } };
    } };
    const profile = normalizeEngineProfileConfig({ schemaVersion: 2, mode: 'team', agentKind: 'codex',
      codex: { binaryPath: binary }, permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' } });
    const runtime = await createSpaceEngineRuntime({ profile, paths, profileId: 'p', ...(driver === 'execution' ? { executionBackend: backend } : {}),
      deployment: { engineId: 'codex', binary, binaryVersion: 'fixture', readonlyResources: [resources], launch: {
        driver, environment: {}, executableRoots: [bin], workspaceAccess: 'workspace' } } });
    try {
      const options = { runId: 'r', scopeId: 's', cwd: paths.workspace, prompt: 'hello', sandbox: 'workspace-write' as const };
      await runtime.execution.prepareRun?.(options);
      const run = runtime.execution.run(options);
      const events = [];
      for await (const event of run.events) events.push(event);
      expect(events.filter(e => e.type === 'error')).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({ type: 'done', terminationReason: 'normal' }));
      await runtimeQueries(runtime).listHistory!({ cwd: paths.workspace, limit: 5 });
      expect((await readFile(join(paths.state, 'spawns'), 'utf8')).trim().split('\n')).toHaveLength(1);
      if (driver === 'execution') expect(commands).toContain(paths.state);
      expect((await readFile(cwdLog, 'utf8')).trim().split('\n').at(-1)).toBe(driver === 'execution' ? paths.state : paths.engine);
    } finally { await runtime.dispose(); }
    expect(closes).toBe(driver === 'execution' ? 1 : 0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);

it('initializes packages only under container ownership and releases that ownership on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-package-lifecycle-'));
  let opens = 0, closes = 0, commands = 0;
  try {
    const { createHash } = await import('node:crypto');
    const key = { kind: 'default', profileId: 'p' } as const;
    const paths = resolveSpacePaths(root, key);
    const module = join(root, 'package.mjs');
    const source = `export const environmentPackageRevision='1';
      export async function prepareSpaceEnvironment(context) {
        const {readFile} = await import('node:fs/promises');
        if(await readFile(context.paths.home+'/owned','utf8') !== 'yes') throw new Error('initialized before ownership');
        throw new Error('package initialization failed');
      }`;
    await writeFile(module, source, { mode: 0o600 });
    const backend: ExecutionBackend = { id: 'fixture', async open() {
      opens++; await writeFile(join(paths.home, 'owned'), 'yes');
      return { id: 'fixture', prepare() { commands++; throw new Error('engine must not start'); }, async close() { closes++; } };
    } };
    const profile = normalizeEngineProfileConfig({schemaVersion:2,mode:'team',agentKind:'codex',codex:{binaryPath:'/usr/bin/false'},
      permissions:{defaultAccess:'workspace',maxAccess:'workspace'}});
    await expect(createSpaceEngineRuntime({profile,paths,profileId:'p',spaceKey:key,executionBackend:backend,
      deployment:{engineId:'codex',binary:'/usr/bin/false',binaryVersion:'fixture',
        environmentPackages:[{id:'example',revision:'1',module,sha256:createHash('sha256').update(source).digest('hex')}],
        launch:{driver:'execution',environment:{},executableRoots:[],workspaceAccess:'workspace'}}})).rejects.toThrow('package initialization failed');
    expect({opens,closes,commands}).toEqual({opens:1,closes:1,commands:0});
  } finally { await rm(root,{recursive:true,force:true}); }
});

it('refuses a read-only mount overlapping private Space state before acquiring a worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-resource-overlap-'));
  let opens = 0;
  try {
    const paths = resolveSpacePaths(root, { kind: 'default', profileId: 'p' });
    const profile = normalizeEngineProfileConfig({schemaVersion:2,mode:'team',agentKind:'codex',codex:{binaryPath:process.execPath},
      permissions:{defaultAccess:'workspace',maxAccess:'workspace'}});
    const backend: ExecutionBackend = { id: 'fixture', async open() { opens++; throw Error('must not open'); } };
    await expect(createSpaceEngineRuntime({profile, paths, profileId:'p', executionBackend:backend,
      deployment:{engineId:'codex',binary:process.execPath,binaryVersion:process.version,readonlyResources:[root],
        launch:{driver:'execution',environment:{},executableRoots:[],workspaceAccess:'workspace'}}})).rejects.toThrow('overlaps');
    expect(opens).toBe(0);
  } finally { await rm(root,{recursive:true,force:true}); }
});
