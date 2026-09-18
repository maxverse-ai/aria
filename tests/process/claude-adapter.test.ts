import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('ClaudeAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh run with stream-json, verbose, permission mode, and bridge prompt args', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-fresh' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      scopeId: 'scope-claude',
      prompt: 'hello',
      cwd: fake.dir,
      permissionMode: 'acceptEdits',
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    // The prompt goes via stdin as a stream-json user message, and the bridge
    // system prompt via a temp file, so neither ever touches argv (which
    // cmd.exe would mangle on Windows).
    const stdinMessages = record.stdin.trim().split('\n').map((l) => JSON.parse(l));
    expect(stdinMessages).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      },
    ]);
    expect(record.argv.slice(0, 9)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--append-system-prompt-file',
    ]);
    expect(record.argv).not.toContain('hello');
    expect(record.systemPrompt).toContain('Aria 运行约定');
    expect(record.systemPrompt).not.toContain('__bridge_cb');
    expect(record.systemPrompt).toContain('LARK_CHANNEL_PROFILE');
    expect(record.systemPrompt).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(record.systemPrompt).not.toContain('lark-cli config bind --source lark-channel');
    expect(record.systemPrompt).not.toContain('__claude_cb');
    expect(record.argv).not.toContain('--resume');
    expect(record.argv).not.toContain('--model');
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-profile' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'codex-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'codex-dev', 'lark-cli-source', 'config.json');

    const run = new ClaudeAdapter({
      binary: fake.path,
      ariaChannel: {
        profile: 'codex-dev',
        rootDir,
        configPath,
        larkCliConfigDir,
        larkCliSourceConfigFile,
      },
    }).run({
      runId: 'run-profile-env',
      scopeId: 'scope-claude',
      prompt: 'profile',
      cwd: fake.dir,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
  });

  it('passes resume and model after the base CLI contract', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-resumed' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      scopeId: 'scope-claude',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'sess-old',
      model: 'sonnet',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual(['--resume', 'sess-old', '--model', 'sonnet']);
    expect(record.argv[7]).toBe('bypassPermissions');
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'before failure' }] } }],
      stderr: 'boom\n',
      exitCode: 42,
      exitAfterFirstMessage: true,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      scopeId: 'scope-claude',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'claude exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<ClaudeAdapter['run']>;
    if (process.platform === 'win32') {
      const fake = await createFakeClaude({
        lines: [],
        stderr: 'missing command\n',
        exitCode: 1,
      });
      cleanup.push(fake.dir);
      run = new ClaudeAdapter({ binary: fake.path }).run({
        runId: 'run-missing',
        scopeId: 'scope-claude',
        prompt: 'hi',
        cwd: fake.dir,
      });
    } else {
      const missing = join(tmpdir(), `missing-claude-${Date.now()}`);
      run = new ClaudeAdapter({ binary: missing }).run({
        runId: 'run-missing',
        scopeId: 'scope-claude',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn claude|spawn returned no pid|claude exited with code/,
    );
  });

  it('waits for post-done process exit before stop fallback is needed', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-tail' }],
      exitDelayMs: 150,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-tail',
      scopeId: 'scope-claude',
      prompt: 'tail',
      cwd: fake.dir,
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-tail', terminationReason: 'normal' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    expect(await run.waitForExit(1_000)).toBe(true);
    await iterator.return?.();
  });

  it('steers an active turn by writing a mid-turn user message to stdin', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }],
      holdResult: true,
      echoSteer: true,
      result: { type: 'result', session_id: 'sess-steer' },
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-steer',
      scopeId: 'scope-claude',
      prompt: 'inspect',
      cwd: fake.dir,
    });
    expect(run.steering).toEqual({
      mode: 'direct',
      textOnly: true,
      mechanism: 'stdio-push',
      delivery: 'none',
    });
    const events = run.events[Symbol.asyncIterator]();
    await expect(events.next()).resolves.toMatchObject({ value: { type: 'text' } });

    const request = {
      requestId: 'steer-1',
      expectedRunId: run.runId,
      prompt: 'change direction',
    };
    const accepted = { kind: 'accepted', runId: run.runId, insertion: 'unconfirmed' };
    await expect(run.steer!(request)).resolves.toEqual(accepted);
    await expect(run.steer!(request)).resolves.toEqual(accepted);
    await expect(run.steer!({
      requestId: 'steer-stale',
      expectedRunId: 'other-run',
      prompt: 'too late',
    })).resolves.toEqual({ kind: 'rejected', reason: 'stale-run' });
    await expect(run.steer!({
      requestId: 'steer-empty',
      expectedRunId: run.runId,
      prompt: ' ',
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-input' });

    const rest: AgentEvent[] = [];
    while (true) {
      const next = await events.next();
      if (next.done) break;
      rest.push(next.value);
    }
    // The fake echoes the steered text back — the only delivery evidence a
    // stdio push can produce.
    expect(rest).toContainEqual({
      type: 'steer_delivery',
      requestId: 'steer-1',
      insertion: 'into-active-turn',
    });
    expect(rest.at(-1)).toEqual({
      type: 'done',
      sessionId: 'sess-steer',
      terminationReason: 'normal',
    });

    const record = await readRecord(fake.recordPath);
    const stdinTexts = record.stdin.trim().split('\n')
      .map((l) => JSON.parse(l).message.content[0].text);
    expect(stdinTexts).toEqual(['inspect', 'change direction']);
    await run.stop();
  });

  it('defers a steer written inside the post-tool drop window', async () => {
    const fake = await createFakeClaude({
      lines: [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'shell', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      ],
      holdResult: true,
      result: { type: 'result', session_id: 'sess-gate' },
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-gate',
      scopeId: 'scope-claude',
      prompt: 'inspect',
      cwd: fake.dir,
    });
    const events = run.events[Symbol.asyncIterator]();
    await events.next();
    await events.next();

    await expect(run.steer!({
      requestId: 'steer-window',
      expectedRunId: run.runId,
      prompt: 'in the drop window',
    })).resolves.toEqual({ kind: 'deferred', reason: 'turn-not-ready' });

    await new Promise((resolve) => setTimeout(resolve, 900));
    await expect(run.steer!({
      requestId: 'steer-after',
      expectedRunId: run.runId,
      prompt: 'after the window',
    })).resolves.toEqual({ kind: 'accepted', runId: run.runId, insertion: 'unconfirmed' });

    while (!(await events.next()).done) {
      // Drain the turn.
    }
    await run.stop();
  });

  it('defers steering once the turn has ended', async () => {
    const fake = await createFakeClaude({
      lines: [],
      result: { type: 'result', session_id: 'sess-done' },
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-done',
      scopeId: 'scope-claude',
      prompt: 'inspect',
      cwd: fake.dir,
    });
    await collect(run.events);
    await expect(run.steer!({
      requestId: 'steer-late',
      expectedRunId: run.runId,
      prompt: 'too late',
    })).resolves.toEqual({ kind: 'deferred', reason: 'turn-closing' });
  });

  it('exposes no steering when the adapter disables it', async () => {
    const fake = await createFakeClaude({
      lines: [],
      result: { type: 'result', session_id: 'sess-off' },
    });
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path, steering: 'off' }).run({
      runId: 'run-off',
      scopeId: 'scope-claude',
      prompt: 'inspect',
      cwd: fake.dir,
    });
    expect(run.steering).toBeUndefined();
    expect(run.steer).toBeUndefined();
    await collect(run.events);
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new ClaudeAdapter({ binary: 'unused' }).run({
        runId: 'run-no-cwd',
        scopeId: 'scope-claude',
        prompt: 'hi',
      }),
    ).toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeClaude(options: {
  lines: unknown[];
  /** Result payload for turn end; emitted after `lines` unless `holdResult`. */
  result?: unknown;
  /** Hold the turn open: the result only arrives after a second stdin line. */
  holdResult?: boolean;
  /** Echo a steered message back as a `user` event before the result. */
  echoSteer?: boolean;
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
  /** Exit right after the first-message burst without waiting for stdin end. */
  exitAfterFirstMessage?: boolean;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-adapter-test-'));
  const path = join(dir, 'fake-claude.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync, readFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'const spIdx = argv.indexOf("--append-system-prompt-file");',
      'const systemPrompt = spIdx !== -1 ? readFileSync(argv[spIdx + 1], "utf8") : null;',
      `const lines = ${JSON.stringify(options.lines)};`,
      `const result = ${JSON.stringify(options.result ?? null)};`,
      'let stdin = "";',
      'let buffer = "";',
      'let first = true;',
      'const emit = (v) => console.log(JSON.stringify(v));',
      'const textOf = (m) => (m?.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\\n");',
      'const finish = () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv,',
      '    stdin,',
      '    systemPrompt,',
      '    cwd: process.cwd(),',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '    },',
      '  }));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '};',
      'process.stdin.on("data", (c) => {',
      '  buffer += c;',
      '  let nl;',
      '  while ((nl = buffer.indexOf("\\n")) >= 0) {',
      '    const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);',
      '    if (!line.trim()) continue;',
      '    stdin += line + "\\n";',
      '    const msg = JSON.parse(line);',
      '    if (first) {',
      '      first = false;',
      '      for (const l of lines) emit(l);',
      options.holdResult ? '' : '      if (result) emit(result);',
      options.exitAfterFirstMessage ? '      finish();' : '',
      '    } else {',
      options.echoSteer ? '      emit({ type: "user", message: { content: [{ type: "text", text: textOf(msg) }] } });' : '',
      options.holdResult ? '      if (result) emit(result);' : '',
      '    }',
      '  }',
      '});',
      'process.stdin.on("end", finish);',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  stdin: string;
  systemPrompt: string | null;
  cwd: string;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    LARK_CHANNEL_HOME?: string;
    LARK_CHANNEL_CONFIG?: string;
    LARKSUITE_CLI_CONFIG_DIR?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    stdin: string;
    systemPrompt: string | null;
    cwd: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
    };
  };
}
