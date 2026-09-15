import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { importCodexSessions } from '../../src/agent/engines/codex/session-import';
import { normalizeEngineProfileConfig } from '../../src/config/profile-schema';
import { resolveSpacePaths, prepareSpacePaths } from '../../src/space/paths';
import { digest } from '../../src/space/deployment';
import { withConfinedLaunch } from '../../src/space/launch';
import { startCodexAppServer } from '../../src/agent/engines/codex/app-server/process';
import { createSpaceEngineRuntime } from '../../src/space/engine-runtime';
import { runtimeQueries } from '../../src/agent/runtime/queries';

// Optional native acceptance, separate from the deterministic fixture gate.
// Set an exact installed binary explicitly. No real home or model credentials.
it.skipIf(!process.env.ARIA_TEST_CODEX_BINARY)('real Codex: imported native id survives process restart and appears in the owned history index', async () => {
  const root = await mkdtemp(join(process.env.ARIA_TEST_NATIVE_PARENT ?? tmpdir(), 'aria-native-import-'));
  try {
    const binary = process.env.ARIA_TEST_CODEX_BINARY!;
    const paths = resolveSpacePaths(root, { kind: 'default', profileId: 'fixture' });
    await prepareSpacePaths(paths);
    const profile = normalizeEngineProfileConfig({ schemaVersion: 2, mode: 'team', agentKind: 'codex',
      codex: { binaryPath: binary }, permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' } });
    await mkdir(join(paths.home, '.codex'), { recursive: true });
    await writeFile(join(paths.home, '.codex', 'config.toml'), [
      'model = "gpt-5.4"', 'model_provider = "fixture"', '[model_providers.fixture]',
      'name = "Offline fixture"', 'base_url = "http://127.0.0.1:1/v1"', 'wire_api = "responses"',
      'requires_openai_auth = false', '',
    ].join('\n'));
    const id = randomUUID(), timestamp = '2026-09-07T00:00:00Z';
    const sourceFile = join(root, 'rollout-2026-09-07T00-00-00-' + id + '.jsonl');
    const contents = [
      { timestamp, type: 'session_meta', payload: { id, timestamp, cwd: '/legacy-workspace', originator: 'codex_cli_rs',
        cli_version: '0.153.4', source: 'cli', model_provider: 'fixture' } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fixture previous question' }] } },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'fixture previous question', images: [], local_images: [], text_elements: [] } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture previous answer' }] } },
      { timestamp, type: 'event_msg', payload: { type: 'agent_message', message: 'fixture previous answer', phase: 'final_answer' } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n';
    await writeFile(sourceFile, contents, { mode: 0o600 });
    const launch = { driver: 'trusted-process' as const, binary, paths, environment: {}, executableRoots: [],
      workspaceAccess: 'workspace' as const };
    const receipt = await importCodexSessions({ sources: [{ nativeId: id, sourceFile, sha256: digest(contents) }],
      binary, profile, workspace: paths.workspace, home: paths.home, stateDirectory: paths.engine,
      withLaunch: (operation) => withConfinedLaunch(launch, operation) });
    expect(receipt.nativeIds).toEqual([id]);
    expect(await readFile(sourceFile, 'utf8')).toBe(contents);
    const client = await withConfinedLaunch(launch, () => startCodexAppServer({ binary, cwd: paths.workspace,
      codexHome: join(paths.home, '.codex'), inheritCodexHome: false, profileStateDir: paths.engine }));
    try {
      const resumed = await client.request<{ thread: { id: string } }>('thread/resume', {
        threadId: id, cwd: paths.workspace, approvalPolicy: 'never', sandbox: 'workspace-write', excludeTurns: true,
      });
      expect(resumed.thread.id).toBe(id);
      const read = await client.request<{ thread: { turns: unknown[] } }>('thread/read', { threadId: id, includeTurns: true });
      expect(JSON.stringify(read)).toContain('fixture previous question');
      expect(JSON.stringify(read)).toContain('fixture previous answer');
    } finally { await client.dispose(); }
    const runtime = await createSpaceEngineRuntime({ profile, paths, deployment: { engineId: 'codex', binary,
      binaryVersion: '0.153.4', launch } });
    try {
      expect(await runtimeQueries(runtime).listHistory!({ cwd: paths.workspace, limit: 10 })).toContainEqual(expect.objectContaining({ id }));
      expect(await runtimeQueries(runtime).listHistory!({ cwd: join(paths.workspace, 'other-project'), limit: 10 })).toEqual([]);
    } finally { await runtime.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
