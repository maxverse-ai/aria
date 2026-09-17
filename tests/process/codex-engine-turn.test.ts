import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerRuntime } from '../../src/agent/engines/codex/app-server/runtime';
import { runtimeQueries, type EngineTurnRef } from '../../src/agent/runtime/queries';
import type { AgentEvent } from '../../src/agent/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('engine-started turns', () => {
  /**
   * A goal continuation looks like this to a client: a turn nobody asked for.
   * The runtime announces it and a caller attaches to the same turn instead of
   * starting one of its own.
   */
  it('announces a turn the engine starts on its own and attaches to it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-engine-turn-'));
    roots.push(root);
    const requestLog = join(root, 'requests.log');
    const binary = join(root, 'codex');
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const requestLog = ${JSON.stringify(requestLog)};
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) {
    if (message.method !== 'initialized') return;
    setTimeout(() => {
      send({ method: 'turn/started', params: { threadId: 'thread-engine', turn: { id: 'turn-engine-1' } } });
      setTimeout(() => {
        send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-engine', turnId: 'turn-engine-1', itemId: 'm1', delta: 'continued on my own' } });
        send({ method: 'item/completed', params: { threadId: 'thread-engine', turnId: 'turn-engine-1', item: { id: 'm1', type: 'agentMessage', text: 'continued on my own' } } });
        send({ method: 'turn/completed', params: { threadId: 'thread-engine', turn: { id: 'turn-engine-1', status: 'completed' } } });
      }, 80);
    }, 20);
    return;
  }
  fs.appendFileSync(requestLog, JSON.stringify({ method: message.method, params: message.params }) + '\\n');
  if (message.method === 'thread/goal/get') return send({ jsonrpc: '2.0', id: message.id, result: { goal: null } });
  send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`, { mode: 0o700 });
    await chmod(binary, 0o700);

    const runtime = new CodexAppServerRuntime({
      binary,
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });
    try {
      const queries = runtimeQueries(runtime);
      const announced: EngineTurnRef[] = [];
      queries.engineTurns!.subscribe((turn) => announced.push(turn));

      // Any request opens the profile's connection; the engine turn follows it.
      await queries.goal!.get('thread-engine');
      const deadline = Date.now() + 5_000;
      while (announced.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(announced).toEqual([{ threadId: 'thread-engine', turnId: 'turn-engine-1' }]);

      const run = await queries.adoptedTurn!({ threadId: 'thread-engine', turnId: 'turn-engine-1', cwd: root });
      const events: AgentEvent[] = [];
      for await (const event of run.events) events.push(event);

      expect(events[0]).toMatchObject({ type: 'system', threadId: 'thread-engine' });
      expect(events.some((event) => event.type === 'text' || event.type === 'final_text')).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'done', threadId: 'thread-engine' });

      const methods = (await readFile(requestLog, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line).method);
      // Attaching must never start a second turn on the engine's thread.
      expect(methods).not.toContain('turn/start');
      expect(methods).not.toContain('thread/start');
    } finally {
      await runtime.dispose();
    }
  });
});
