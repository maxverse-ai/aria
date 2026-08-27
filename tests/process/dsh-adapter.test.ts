import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter } from '../../src/agent/engines/dsh/adapter.js';
import { buildDshArgs } from '../../src/agent/engines/dsh/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface RecordPayload {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

describe('DshAdapter process contract', () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanups.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('runs one headless task and emits the final answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-adapter-'));
    cleanups.push(dir);
    const binary = await createFakeDsh(dir, 'answer from dsh', 0);
    const cwd = await realpath(dir);

    const run = new DshAdapter({ binary, profileStateDir: dir }).run({
      runId: 'run-dsh',
      prompt: 'hello',
      cwd,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'final_text', content: 'answer from dsh' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const record = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8')) as RecordPayload;
    expect(record.argv).toEqual(['--profile', 'headless', expect.stringContaining('hello')]);
    expect(record.argv[2]).toContain('Aria 运行约定');
    expect(record.argv[2]).toContain('hello');
  });

  it('emits an error when dsh exits nonzero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-adapter-'));
    cleanups.push(dir);
    const binary = await createFakeDsh(dir, '', 1);
    const cwd = await realpath(dir);

    const run = new DshAdapter({ binary, profileStateDir: dir }).run({
      runId: 'run-dsh-fail',
      prompt: 'boom',
      cwd,
    });

    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });
});

async function createFakeDsh(dir: string, answer: string, exitCode: number): Promise<string> {
  const file = join(dir, 'dsh');
  await writeFile(
    file,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'fs.writeFileSync(',
      "  require('node:path').join(process.env.FAKE_DSH_DIR, 'record.json'),",
      '  JSON.stringify({ argv: process.argv.slice(2), env: process.env }),',
      ');',
      `if (${JSON.stringify(answer)}) console.log(${JSON.stringify(answer)});`,
      `process.exit(${exitCode});`,
    ].join('\n'),
    { mode: 0o755 },
  );
  await chmod(file, 0o755);
  process.env.FAKE_DSH_DIR = dir;
  return file;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
