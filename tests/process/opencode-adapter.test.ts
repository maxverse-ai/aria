import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeAdapter } from '../../src/agent/engines/opencode/adapter.js';
import { buildOpenCodeArgs } from '../../src/agent/engines/opencode/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface RecordPayload {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
}

describe('OpenCodeAdapter process contract', () => {
  const cleanups: string[] = [];
  const savedEnv: Record<string, string | undefined> = {
    RECORD_PATH: process.env.RECORD_PATH,
    LINES: process.env.LINES,
    FAKE_EXIT_CODE: process.env.FAKE_EXIT_CODE,
  };

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(
      cleanups.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh JSON run with prompt on stdin and streams text to final', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-adapter-'));
    cleanups.push(dir);
    const binary = await createFakeOpenCode(dir);
    const cwd = await realpath(dir);
    const recordPath = join(dir, 'record.json');
    process.env.RECORD_PATH = recordPath;
    process.env.LINES = JSON.stringify([
      JSON.stringify({ type: 'text', timestamp: 1, sessionID: 'ses_1', part: { id: 'prt_a', type: 'text', text: 'first', time: { start: 1, end: 2 } } }),
      JSON.stringify({ type: 'text', timestamp: 2, sessionID: 'ses_1', part: { id: 'prt_b', type: 'text', text: 'second', time: { start: 2, end: 3 } } }),
    ]);

    const run = new OpenCodeAdapter({ binary, profileStateDir: dir }).run({
      runId: 'run-fresh',
      scopeId: 'scope-opencode',
      prompt: 'hello from lark',
      cwd,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'first' },
      { type: 'final_text', content: 'second' },
      { type: 'done', sessionId: 'ses_1', terminationReason: 'normal' },
    ]);

    const record = JSON.parse(await readFile(recordPath, 'utf8')) as RecordPayload;
    expect(record.argv).toEqual(buildOpenCodeArgs({ cwd }));
    expect(record.argv).not.toContain('--auto');
    expect(record.stdin).toContain('Aria 运行约定');
    expect(record.stdin).not.toContain('__bridge_cb');
    expect(record.stdin).toContain('hello from lark');
    expect(record.env.LARK_CHANNEL).toBe('1');
  });

  it('passes session id through argv and honors profile XDG isolation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-adapter-'));
    cleanups.push(dir);
    const binary = await createFakeOpenCode(dir);
    const cwd = await realpath(dir);
    const recordPath = join(dir, 'record.json');
    process.env.RECORD_PATH = recordPath;
    process.env.LINES = '[]';

    const run = new OpenCodeAdapter({
      binary,
      profileStateDir: dir,
      xdg: { dataHome: '/tmp/oc-data', configHome: '/tmp/oc-config' },
    }).run({
      runId: 'run-resume',
      scopeId: 'scope-opencode',
      prompt: 'continue',
      cwd,
      sessionId: 'ses_old',
    });

    await collect(run.events);
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as RecordPayload;
    expect(record.argv).toEqual(
      buildOpenCodeArgs({ cwd, sessionId: 'ses_old' }),
    );
    expect(record.env.XDG_DATA_HOME).toBe('/tmp/oc-data');
    expect(record.env.XDG_CONFIG_HOME).toBe('/tmp/oc-config');
    expect(record.env.OPENCODE_CONFIG_DIR).toBe('/tmp/oc-config');
  });

  it('appends engine effort flags when reasoning effort is requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-adapter-'));
    cleanups.push(dir);
    const binary = await createFakeOpenCode(dir);
    const cwd = await realpath(dir);
    process.env.RECORD_PATH = join(dir, 'record.json');
    process.env.LINES = '[]';

    const run = new OpenCodeAdapter({
      binary,
      profileStateDir: dir,
      effortFlag: (value) => ['--variant', value],
    }).run({
      runId: 'run-effort',
      scopeId: 'scope-opencode',
      prompt: 'deep',
      cwd,
      reasoningEffort: 'high',
    });

    await collect(run.events);
    const record = JSON.parse(await readFile(process.env.RECORD_PATH, 'utf8')) as RecordPayload;
    expect(record.argv).toContain('--variant');
    expect(record.argv).toContain('high');
  });

  it('emits an error event when opencode exits nonzero without a terminal line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-adapter-'));
    cleanups.push(dir);
    const binary = await createFakeOpenCode(dir);
    const cwd = await realpath(dir);
    process.env.RECORD_PATH = join(dir, 'record.json');
    process.env.LINES = '[]';
    process.env.FAKE_EXIT_CODE = '3';

    const run = new OpenCodeAdapter({ binary, profileStateDir: dir }).run({
      runId: 'run-fail',
      scopeId: 'scope-opencode',
      prompt: 'boom',
      cwd,
    });

    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((events[0] as { message: string }).message).toContain('opencode exited with code 3');
  });
});

async function createFakeOpenCode(dir: string): Promise<string> {
  const file = join(dir, 'opencode');
  await writeFile(
    file,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "let stdin = '';",
      "process.stdin.on('data', (c) => (stdin += c));",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(process.env.RECORD_PATH, JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin }));",
      "  const lines = JSON.parse(process.env.LINES || '[]');",
      "  for (const line of lines) process.stdout.write(line + '\\n');",
      "  process.exit(Number(process.env.FAKE_EXIT_CODE || '0'));",
      '});',
    ].join('\n'),
    { mode: 0o755 },
  );
  await chmod(file, 0o755);
  return file;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
