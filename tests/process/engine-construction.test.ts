import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/agent/types';
import { normalizeEngineProfileConfig, type EngineProfileConfig } from '../../src/config/profile-schema';
import { createProfileConversationHost } from '../../src/conversation/profile-host';
import { prepareProfileEngineRuntime } from '../../src/runtime/agent-runtime';

const allEngines = ['claude', 'codex', 'grok', 'opencode', 'dsh', 'kimi', 'pi'] as const;
type Engine = typeof allEngines[number];
// `dsh` reports progress over an extra stdio descriptor, which Node only
// supports on POSIX hosts, so its launch cases do not apply on Windows.
const engines: readonly Engine[] = process.platform === 'win32'
  ? allEngines.filter((engine) => engine !== 'dsh')
  : allEngines;
const roots: string[] = [];
const envKeys = [
  'LARK_CHANNEL', 'LARK_CHANNEL_PROFILE', 'LARK_CHANNEL_HOME',
  'LARK_CHANNEL_CONFIG', 'LARKSUITE_CLI_CONFIG_DIR',
  'CODEX_HOME', 'GROK_HOME', 'GROK_DISABLE_AUTOUPDATER', 'DSH_HOME',
  'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
];
interface LaunchRecord {
  engine: Engine;
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: string;
  systemPrompt: string;
  requests: Array<{ method?: string; params?: Record<string, unknown> }>;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })));
});

describe('prepared profile runtime process compatibility', () => {
  for (const custom of [false, true]) {
    it.each(engines)('preserves ' + (custom ? 'configured/full-access' : 'default/workspace-access') +
      ' %s launch behavior after caller configuration changes', async (engine) => {
      const root = await temporaryRoot();
      const binary = await fakeBinary(root, engine);
      if (engine === 'claude') {
        // Claude's existing factory uses the literal command "claude".
        vi.stubEnv('PATH', root + delimiter + (process.env.PATH ?? ''));
      }
      const stateDirectory = join(root, 'state');
      const paths = {
        profileDir: stateDirectory,
        profile: 'construction-test',
        rootDir: root,
        configFile: join(root, 'fallback.json'),
        configPath: join(root, 'explicit.json'),
        larkCliConfigDir: join(root, 'private-cli'),
        larkCliSourceConfigFile: join(root, 'private-source.json'),
      };
      const profile = profileFor(engine, binary, root, custom);
      const prepared = prepareProfileEngineRuntime(profile, paths);
      expect(await readdir(root)).not.toContain('state');
      expect(await readdir(root)).not.toContain('launch.json');

      // The prepared instance must not retain mutable host configuration.
      paths.profile = 'changed-after-prepare';
      paths.profileDir = join(root, 'wrong-state');
      paths.larkCliSourceConfigFile = join(root, 'wrong-source.json');
      profile.permissions.defaultAccess = custom ? 'workspace' : 'full';
      profile.sandbox.defaultMode = 'read-only';
      if (engine !== 'claude') profile[engine]!.binaryPath = join(root, 'wrong-binary');
      if (profile.opencode) profile.opencode.configHome = join(root, 'wrong-xdg');
      if (profile.pi) profile.pi.sessionDir = join(root, 'wrong-sessions');

      const runtime = prepared.create();
      try {
        const run = runtime.execution.run({
          runId: 'construction-run',
          identity: { providerId: 'lark', accountId: 'app', subjectId: 'ou_construction_fixture', displayName: 'Fixture Agent' },
          scopeId: 'construction-scope',
          prompt: 'construction prompt',
          cwd: root,
          sessionId: 'session-old',
          threadId: 'thread-old',
          model: 'test-model',
          reasoningEffort: 'high',
          permissionMode: 'acceptEdits',
        });
        const events: AgentEvent[] = [];
        for await (const event of run.events) events.push(event);
        expect(events.filter((event) => event.type === 'error')).toEqual([]);
        expect(events).toContainEqual(expect.objectContaining({ type: 'done', terminationReason: 'normal' }));
        expect(await run.waitForExit(1_000)).toBe(true);
      } finally {
        await runtime.dispose();
      }

      const record = await readLaunch(root);
      expect(record.engine).toBe(engine);
      expect(record.env).toMatchObject({
        LARK_CHANNEL: '1',
        LARK_CHANNEL_PROFILE: 'construction-test',
        LARK_CHANNEL_HOME: root,
        LARK_CHANNEL_CONFIG: join(root, 'private-source.json'),
        LARKSUITE_CLI_CONFIG_DIR: join(root, 'private-cli'),
      });
      expect(await realpath(record.cwd)).toBe(
        await realpath(['codex', 'grok'].includes(engine) ? stateDirectory : root),
      );
      const prompts = [record.stdin, record.systemPrompt, ...record.argv, JSON.stringify(record.requests)].join('\n');
      expect(prompts).toContain('Aria 运行约定');
      expect(prompts).toContain('ou_construction_fixture');
      expect(prompts).toContain('construction prompt');

      switch (engine) {
        case 'claude':
        case 'kimi':
          expect(record.argv.slice(0, 7)).toEqual([
            '-p', '--output-format', 'stream-json', '--verbose',
            '--permission-mode', 'acceptEdits', '--append-system-prompt-file',
          ]);
          expect(record.argv.slice(8)).toEqual(['--resume', 'session-old', '--model', 'test-model']);
          expect(record.stdin).toBe('construction prompt');
          expect(record.systemPrompt).toContain('Aria 运行约定');
          break;
        case 'codex':
          expect(record.argv).toEqual([
            'app-server', '--stdio', '-c', 'approval_policy="never"',
            '-c', 'shell_environment_policy.inherit="all"',
          ]);
          expect(record.env.CODEX_HOME).toBe(custom ? join(root, 'custom-codex') : process.env.CODEX_HOME);
          expect(record.requests.find((request) => request.method === 'thread/resume')?.params)
            .toMatchObject({
              threadId: 'thread-old',
              cwd: root,
              approvalPolicy: 'never',
              sandbox: custom ? 'danger-full-access' : 'workspace-write',
              model: 'test-model',
            });
          break;
        case 'grok':
          expect(record.argv).toEqual([
            '--sandbox', custom ? 'off' : 'workspace',
            ...(custom ? ['--always-approve'] : []), 'agent', '--no-leader', 'stdio',
          ]);
          expect(record.env.GROK_HOME).toBe(custom ? join(root, 'custom-grok') : process.env.GROK_HOME);
          expect(record.env.GROK_DISABLE_AUTOUPDATER).toBe('1');
          expect(record.requests.find((request) => request.method === 'session/load')?.params)
            .toMatchObject({ sessionId: 'session-old', cwd: root, _meta: { yoloMode: custom } });
          break;
        case 'opencode':
          expect(record.argv).toEqual([
            'run', '--session', 'session-old', '--model', 'test-model',
            ...(custom ? ['--auto'] : []), '--format', 'json', '--dir', root, '--variant', 'high',
          ]);
          for (const [key, directory] of [
            ['XDG_DATA_HOME', 'data'], ['XDG_CONFIG_HOME', 'config'],
            ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 'state'],
            ['OPENCODE_CONFIG_DIR', 'config'],
          ] as const) {
            expect(record.env[key]).toBe(custom ? join(root, 'custom-xdg', directory) : process.env[key]);
          }
          break;
        case 'pi':
          expect(record.argv.slice(0, -1)).toEqual([
            '-p', '--mode', 'json', '--session', 'session-old', '--model', 'test-model',
            '--thinking', 'high', ...(custom ? ['--approve'] : []),
            '--session-dir', join(root, custom ? 'custom-pi' : 'state/pi-sessions'),
          ]);
          break;
        case 'dsh':
          expect(record.argv.slice(0, 2)).toEqual(['--profile', 'headless']);
          expect(record.argv).toHaveLength(5);
          expect(record.argv[2]).toBe('--patch');
          expect(record.argv[3]).toMatch(/dsh-progress-.*[\\/]patch\.json$/);
          expect(record.env.DSH_HOME).toBe(join(root, custom ? 'custom-dsh' : 'state/dsh-home'));
          break;
      }
      expect(await readdir(root)).not.toContain('spaces');
      expect(await readdir(root)).not.toContain('wrong-state');
    });
  }

  it.each(['codex', 'grok'] as const)('preserves explicit home inheritance selection for %s', async (engine) => {
    const root = await temporaryRoot();
    const binary = await fakeBinary(root, engine);
    const profile = profileFor(engine, binary, root, false);
    if (engine === 'codex') profile.codex!.inheritCodexHome = false;
    else profile.grok!.inheritGrokHome = false;
    const runtime = prepareProfileEngineRuntime(profile, { profileDir: join(root, 'state') }).create();
    try {
      const run = runtime.execution.run({
        runId: 'home-run', scopeId: 'home-scope', cwd: root, prompt: 'home selection',
      });
      for await (const event of run.events) expect(event.type).not.toBe('error');
    } finally {
      await runtime.dispose();
    }
    const record = await readLaunch(root);
    expect(record.env[engine === 'codex' ? 'CODEX_HOME' : 'GROK_HOME']).toBe(
      join(root, 'state', engine + '-home'),
    );
    // A channel-free construction leaves the existing ambient binding intact.
    for (const key of envKeys.filter((key) => key.startsWith('LARK_') && key !== 'LARK_CHANNEL')) {
      expect(record.env[key]).toBe(process.env[key]);
    }
  });

  it('runs the standalone host without channel credentials through the same prepared factory', async () => {
    const root = await temporaryRoot();
    const binary = await fakeBinary(root, 'pi');
    const configPath = join(root, 'worker.json');
    const stored = JSON.stringify({
      kind: 'aria-worker', schemaVersion: 1, activeProfile: 'worker',
      profiles: {
        worker: {
          agentKind: 'pi',
          pi: { binaryPath: binary },
          workspaces: { default: root },
          permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
        },
      },
    });
    await writeFile(configPath, stored);
    const stateDirectory = join(root, 'worker-state');
    const host = await createProfileConversationHost({ configPath, profile: 'worker', stateDirectory });
    try {
      expect(await host.runText({
        scopeId: 'fixture:user', actorId: 'fixture-user', prompt: 'standalone prompt',
        authorized: true, source: 'channel:fixture',
      })).toMatchObject({ ok: true, content: 'fixture answer' });
    } finally {
      await host.close();
    }
    expect(await readFile(configPath, 'utf8')).toBe(stored);
    const record = await readLaunch(root);
    const sessionDirIndex = record.argv.indexOf('--session-dir');
    expect(record.argv[sessionDirIndex + 1]).toBe(join(stateDirectory, 'pi-sessions'));
    expect(record.env.LARK_CHANNEL_PROFILE).toBe(process.env.LARK_CHANNEL_PROFILE);
    expect(await readdir(root)).not.toContain('spaces');
  });
});

function profileFor(engine: Engine, binary: string, root: string, custom: boolean): EngineProfileConfig {
  const settings: Record<string, unknown> = { binaryPath: binary };
  if (custom) {
    if (engine === 'codex') settings.codexHome = join(root, 'custom-codex');
    if (engine === 'grok') settings.grokHome = join(root, 'custom-grok');
    if (engine === 'pi') settings.sessionDir = join(root, 'custom-pi');
    if (engine === 'dsh') settings.dshHome = join(root, 'custom-dsh');
    if (engine === 'opencode') {
      for (const name of ['data', 'config', 'cache', 'state']) {
        settings[name + 'Home'] = join(root, 'custom-xdg', name);
      }
    }
  }
  return normalizeEngineProfileConfig({
    schemaVersion: 2,
    agentKind: engine,
    ...(engine === 'claude' ? {} : { [engine]: settings }),
    permissions: {
      defaultAccess: custom ? 'full' : 'workspace',
      maxAccess: custom ? 'full' : 'workspace',
    },
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aria-construction-process-')));
  roots.push(root);
  return root;
}

async function readLaunch(root: string): Promise<LaunchRecord> {
  return JSON.parse(await readFile(join(root, 'launch.json'), 'utf8'));
}

async function fakeBinary(root: string, engine: Engine): Promise<string> {
  const script = join(root, engine + '.cjs');
  const input = { engine, recordPath: join(root, 'launch.json'), envKeys };
  await writeFile(script,
    '#!' + process.execPath + '\n(' + fakeMain.toString() + ')(' + JSON.stringify(input) + ');\n',
    { mode: 0o755 });
  const binary = join(root, process.platform === 'win32' ? engine + '.cmd' : engine);
  if (process.platform === 'win32') {
    await writeFile(binary, '@echo off\r\n"' + process.execPath + '" "' + script + '" %*\r\n');
  } else {
    await writeFile(binary, await readFile(script), { mode: 0o755 });
    await chmod(binary, 0o755);
  }
  return binary;
}

// Serialized into an independent executable; only Node built-ins are available.
// Record a fixed, non-secret environment allowlist, never the process environment.
function fakeMain(input: { engine: Engine; recordPath: string; envKeys: string[] }): void {
  if (process.argv.includes('--version')) {
    process.stdout.write(input.engine + ' 1.0.0\n');
    process.exit(0);
  }
  const fs = require('node:fs') as typeof import('node:fs');
  const record: LaunchRecord = {
    engine: input.engine, argv: process.argv.slice(2), cwd: process.cwd(),
    env: Object.fromEntries(input.envKeys.map((key) => [key, process.env[key]])),
    stdin: '', systemPrompt: '', requests: [],
  };
  const save = () => fs.writeFileSync(input.recordPath, JSON.stringify(record));
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const promptIndex = record.argv.indexOf('--append-system-prompt-file');
  if (promptIndex >= 0) record.systemPrompt = fs.readFileSync(record.argv[promptIndex + 1]!, 'utf8');
  save();

  if (input.engine === 'codex' || input.engine === 'grok') {
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (line: string) => {
      const message = JSON.parse(line);
      record.requests.push(message);
      save();
      if (message.id === undefined) return;
      const reply = (result: unknown) => send({ jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'initialize') {
        reply(input.engine === 'grok'
          ? { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }
          : { userAgent: 'fixture' });
      } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
        reply({ thread: { id: message.params?.threadId ?? 'thread-new' }, model: 'test-model' });
      } else if (message.method === 'turn/start') {
        reply({ turn: { id: 'turn-fixture' } });
        setImmediate(() => {
          const threadId = message.params.threadId;
          send({ method: 'item/completed', params: {
            threadId, turnId: 'turn-fixture',
            item: { id: 'answer', type: 'agentMessage', text: 'fixture answer' },
          } });
          send({ method: 'turn/completed', params: {
            threadId, turn: { id: 'turn-fixture', status: 'completed', error: null },
          } });
        });
      } else if (message.method === 'session/new' || message.method === 'session/load') {
        reply({ sessionId: message.params?.sessionId ?? 'session-new' });
      } else if (message.method === 'session/prompt') {
        send({ method: 'session/update', params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture answer' } },
        } });
        reply({ stopReason: 'end_turn' });
      } else {
        reply({});
      }
    });
    process.stdin.on('end', () => process.exit(0));
    return;
  }

  const complete = () => {
    save();
    if (input.engine === 'claude' || input.engine === 'kimi') {
      send({ type: 'result', session_id: 'session-old' });
    } else if (input.engine === 'opencode') {
      send({ type: 'text', sessionID: 'session-old', part: { type: 'text', text: 'fixture answer' } });
    } else if (input.engine === 'pi') {
      send({ type: 'session', id: 'session-old' });
      send({ type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }],
      } });
      send({ type: 'agent_end' });
    } else {
      fs.writeSync(3, JSON.stringify({ type: 'ready', version: 1 }) + '\n');
      process.stdout.write('fixture answer\n');
    }
  };
  if (input.engine === 'pi' || input.engine === 'dsh') {
    complete();
  } else {
    process.stdin.on('data', (chunk) => { record.stdin += chunk.toString(); });
    process.stdin.on('end', complete);
  }
}
