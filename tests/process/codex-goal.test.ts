import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerRuntime } from '../../src/agent/engines/codex/app-server/runtime';
import { runtimeQueries } from '../../src/agent/runtime/queries';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex thread goal', () => {
  it('reads, writes and clears the goal with the App Server goal methods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-goal-'));
    roots.push(root);
    const requestLog = join(root, 'goal-requests.log');
    const binary = join(root, 'codex');
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const requestLog = ${JSON.stringify(requestLog)};
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let goal = null;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  fs.appendFileSync(requestLog, JSON.stringify({ method: message.method, params: message.params }) + '\\n');
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'thread/goal/get') return reply({ goal });
  if (message.method === 'thread/goal/set') {
    goal = { threadId: message.params.threadId, objective: message.params.objective ?? goal?.objective ?? '',
      status: message.params.status ?? 'active', tokenBudget: message.params.tokenBudget ?? null,
      tokensUsed: 12, timeUsedSeconds: 34, createdAt: 1, updatedAt: 2 };
    return reply({ goal });
  }
  if (message.method === 'thread/goal/clear') { goal = null; return reply({ cleared: true }); }
  reply({});
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
      const goal = runtimeQueries(runtime).goal;
      expect(goal).toBeDefined();

      await expect(goal!.get('thread-1')).resolves.toBeNull();
      await expect(goal!.set('thread-1', { objective: 'ship the goal command', status: 'paused', tokenBudget: 50000 }))
        .resolves.toEqual({
          objective: 'ship the goal command',
          status: 'paused',
          tokenBudget: 50000,
          tokensUsed: 12,
          timeUsedSeconds: 34,
          createdAt: 1,
          updatedAt: 2,
        });
      await expect(goal!.get('thread-1')).resolves.toMatchObject({ objective: 'ship the goal command' });
      await expect(goal!.clear('thread-1')).resolves.toBeUndefined();
      await expect(goal!.get('thread-1')).resolves.toBeNull();

      const requests = (await readFile(requestLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(requests.map((request) => request.method)).toEqual([
        'initialize',
        'thread/goal/get',
        'thread/goal/set',
        'thread/goal/get',
        'thread/goal/clear',
        'thread/goal/get',
      ]);
      expect(requests[2].params).toEqual({ threadId: 'thread-1', objective: 'ship the goal command', status: 'paused', tokenBudget: 50000 });
    } finally {
      await runtime.dispose();
    }
  });
});
