import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessPool } from '../../../src/bot/process-pool';
import { executeCardAction, waitForCardActions } from '../../../src/card/action-executor';
import { CodexAppServerClient, type AppServerChild } from '../../../src/agent/engines/codex/app-server/client';
import { CodexAppServerRuntime } from '../../../src/agent/engines/codex/app-server/runtime';
import { startCodexAppServer } from '../../../src/agent/engines/codex/app-server/process';
import { markSteerMail, putSteerMail, pullSteerMails, withSteerMailSweep, unreadSteerMails } from '../../../src/conversation/steer-mailbox';

vi.mock('../../../src/agent/engines/codex/app-server/process', () => ({ startCodexAppServer: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); });

describe('formal audit regression guards', () => {
  it('reserves the permit for a woken waiter', async () => {
    const pool = new ProcessPool(() => 1);
    const releaseFirst = await pool.acquire();
    const waiting = pool.acquire();
    expect(pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });
    releaseFirst();
    // resolve() queues a microtask; it does not transfer ownership of the slot.
    const releaseNewcomer = pool.tryAcquire();
    const releaseWaiter = await waiting;
    try {
      expect(releaseNewcomer).toBeUndefined();
      expect(pool.snapshot()).toMatchObject({ active: 1, cap: 1 });
    } finally { releaseWaiter(); releaseNewcomer?.(); }
    expect(pool.snapshot().active).toBe(0);
  });

  it('returns the callback before handler I/O starts or completes', async () => {
    let release!: () => void;
    let acknowledged = false;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const action = executeCardAction({ action: 'stop', key: 'audit-card', task: () => barrier })
      .then(() => { acknowledged = true; });
    await Promise.resolve();
    await action;
    expect(acknowledged).toBe(true);
    release();
    await waitForCardActions();
    expect(acknowledged).toBe(true);
  });

  it('restores mail when next-turn submission is rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-audit-mail-'));
    try {
      putSteerMail(root, 'scope', { requestId: 'followup', body: 'must survive rejected preparation' });
      markSteerMail(root, 'scope', 'followup', 'noticed');
      await withSteerMailSweep(root, 'scope', async (mails, begin) => {
        expect(mails).toHaveLength(1);
        expect(pullSteerMails(root, 'scope')).toEqual([]);
        begin();
        return { ok: false };
      });
      expect(unreadSteerMails(root, 'scope')).toHaveLength(1);
      expect(pullSteerMails(root, 'scope')).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not resurrect consumed mail on duplicate deposit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-audit-duplicate-'));
    try {
      const message = { requestId: 'same-input', body: 'once' };
      putSteerMail(root, 'scope', message);
      expect(pullSteerMails(root, 'scope')).toHaveLength(1);
      putSteerMail(root, 'scope', message);
      expect(pullSteerMails(root, 'scope')).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('announces engine turns after client reconnection', async () => {
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
      expect(announced).toEqual(['before-reconnect', 'after-reconnect']);
    } finally { await runtime.dispose(); await first.client.dispose(); }
  });
});
