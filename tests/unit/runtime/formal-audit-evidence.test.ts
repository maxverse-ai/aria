import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessPool } from '../../../src/bot/process-pool';
import { executeCardAction } from '../../../src/card/action-executor';
import { CodexAppServerClient, type AppServerChild } from '../../../src/agent/engines/codex/app-server/client';
import { CodexAppServerRuntime } from '../../../src/agent/engines/codex/app-server/runtime';
import { startCodexAppServer } from '../../../src/agent/engines/codex/app-server/process';
import { markSteerMail, putSteerMail, pullSteerMails, sweepSteerMails, unreadSteerMails } from '../../../src/conversation/steer-mailbox';

vi.mock('../../../src/agent/engines/codex/app-server/process', () => ({ startCodexAppServer: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); });

describe('formal audit: current behavior evidence (not desired-behavior regressions)', () => {
  it('reproduces pool oversubscription when a newcomer steals a woken waiter slot', async () => {
    const pool = new ProcessPool(() => 1);
    const releaseFirst = await pool.acquire();
    const waiting = pool.acquire();
    expect(pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });
    releaseFirst();
    // resolve() queues a microtask; it does not transfer ownership of the slot.
    const releaseNewcomer = pool.tryAcquire();
    const releaseWaiter = await waiting;
    try {
      expect(releaseNewcomer).toBeTypeOf('function');
      expect(pool.snapshot()).toMatchObject({ active: 2, cap: 1 });
    } finally { releaseWaiter(); releaseNewcomer?.(); }
    expect(pool.snapshot().active).toBe(0);
  });

  it('reproduces an immediate callback waiting for handler I/O before acknowledgement', async () => {
    let release!: () => void;
    let acknowledged = false;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const action = executeCardAction({ action: 'stop', key: 'audit-card', task: () => barrier })
      .then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    release();
    await action;
    expect(acknowledged).toBe(true);
  });

  it('reproduces unread mail removed before a next-turn submission can be accepted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-audit-mail-'));
    try {
      putSteerMail(root, 'scope', { requestId: 'followup', body: 'must survive rejected preparation' });
      markSteerMail(root, 'scope', 'followup', 'noticed');
      const preparedPrompt = sweepSteerMails(root, 'scope');
      expect(preparedPrompt).toHaveLength(1);
      // runAgentBatch can now return flow.ok=false or throw before engine submission.
      expect(unreadSteerMails(root, 'scope')).toEqual([]);
      expect(sweepSteerMails(root, 'scope')).toEqual([]);
      expect(pullSteerMails(root, 'scope')).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reproduces resurrection of already consumed mail by a duplicate deposit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-audit-duplicate-'));
    try {
      const message = { requestId: 'same-input', body: 'once' };
      putSteerMail(root, 'scope', message);
      expect(pullSteerMails(root, 'scope')).toHaveLength(1);
      putSteerMail(root, 'scope', message);
      expect(pullSteerMails(root, 'scope')).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reproduces engine turn announcements disappearing after client reconnection', async () => {
    function client() {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(),
        stderr: new PassThrough(), exitCode: 0, signalCode: null });
      return { child, client: new CodexAppServerClient(child as unknown as AppServerChild) };
    }
    const first = client();
    const second = client();
    vi.mocked(startCodexAppServer).mockResolvedValueOnce(first.client).mockResolvedValueOnce(second.client);
    const runtime = new CodexAppServerRuntime({ binary: 'unused', profileStateDir: process.cwd(),
      inheritCodexHome: true, sandbox: 'read-only' });
    const announced: string[] = [];
    runtime.onEngineTurn(turn => { announced.push(turn.turnId); });
    async function emit(s: ReturnType<typeof client>, turnId: string) {
      s.child.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'engine-thread', turn: { id: turnId } } }) + '\n');
      const barrier = s.client.request('test/barrier');
      s.child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
      await barrier;
    }
    try {
      await runtime.client();
      await emit(first, 'before-reconnect');
      expect(announced).toEqual(['before-reconnect']);
      const closed = new Promise<void>(resolve => { first.client.onClosed(() => resolve()); });
      first.child.stdout.end();
      await closed;
      expect(await runtime.client()).toBe(second.client);
      await emit(second, 'after-reconnect');
      expect(announced).toEqual(['before-reconnect']);
    } finally { await runtime.dispose(); await first.client.dispose(); }
  });
});
