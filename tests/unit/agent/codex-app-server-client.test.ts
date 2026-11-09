import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppServerRequestTimeoutError, CodexAppServerClient, type AppServerChild } from '../../../src/agent/engines/codex/app-server/client';
import { log } from '../../../src/core/logger';

const clients: CodexAppServerClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function transport() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(), exitCode: 0, signalCode: null,
  });
  const requests: Array<{ id: number; method: string }> = [];
  child.stdin.on('data', chunk => requests.push(JSON.parse(chunk.toString())));
  const client = new CodexAppServerClient(child as unknown as AppServerChild);
  clients.push(client);
  return { child, client, requests, respond: (id: number, result: unknown = {}) => {
    const line = JSON.stringify({ id, result });
    child.stdout.write(line + '\n');
    return Buffer.byteLength(line, 'utf8');
  }, flush: async () => {
    const barrier = client.request('test/barrier');
    child.stdout.write(JSON.stringify({ id: requests.at(-1)!.id, result: {} }) + '\n');
    await barrier;
  } };
}

describe('Codex RPC request accounting', () => {
  it('records UTF-8 bytes and identifiers without retaining request or response bodies', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const s = transport();
    const result = s.client.request('thread/resume', { threadId: 'thread', prompt: 'PRIVATE INPUT' });
    const responseBytes = s.respond(1, { text: 'PRIVATE RESPONSE 中文' });
    await result;
    expect(info).toHaveBeenCalledWith('codex-app-server', 'rpc', expect.objectContaining({
      requestId: 1, method: 'thread/resume', threadId: 'thread', responseBytes, outcome: 'success',
      clientId: expect.any(String), durationMs: expect.any(Number),
    }));
    const recorded = JSON.stringify(info.mock.calls);
    expect(recorded).not.toContain('PRIVATE');
    expect(recorded).not.toContain('timer');
  });

  it('reports a late response once after timeout and keeps the request rejected', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const s = transport();
    const result = s.client.request('thread/resume', { threadId: 'thread' }, 10).catch(error => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toBeInstanceOf(AppServerRequestTimeoutError);
    s.respond(1);
    s.respond(1);
    await s.flush();
    const late = info.mock.calls.filter(([, , f]) => f?.outcome === 'late-response');
    expect(late).toHaveLength(1);
    expect(late[0]![2]).toMatchObject({ previousOutcome: 'timeout', requestId: 1 });
  });

  it('caps abandoned request metadata at 256 and expires it even without new traffic', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const s = transport();
    const abort = new AbortController();
    const results = Array.from({ length: 258 }, () => s.client.request('thread/resume', {}, 60_000, abort.signal).catch(error => error));
    abort.abort();
    await Promise.all(results);
    // The first two entries were evicted. Entry 3 is recognized once.
    s.respond(1); s.respond(2); s.respond(3);
    await s.flush();
    expect(info.mock.calls.filter(([, , f]) => f?.outcome === 'late-response')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    // No RPC traffic was needed for expiration: its sweep timer is gone.
    expect(vi.getTimerCount()).toBe(0);
    s.respond(4);
    await s.flush();
    expect(info.mock.calls.filter(([, , f]) => f?.outcome === 'late-response')).toHaveLength(1);
  });

  it('rejects every pending request and clears diagnostics when stdout closes', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const s = transport();
    const abandoned = s.client.request('thread/resume', {}, 1).catch(error => error);
    await vi.advanceTimersByTimeAsync(2);
    await abandoned;
    const results = [s.client.request('account/read'), s.client.request('model/list')].map(p => p.catch(error => error));
    s.child.stdout.end();
    for (const result of await Promise.all(results)) expect(result).toMatchObject({ message: expect.stringContaining('stdout ended') });
    expect(vi.getTimerCount()).toBe(0);
    expect(info.mock.calls.filter(([, , f]) => f?.outcome === 'connection-closed')).toHaveLength(2);
  });

  it('cleans up a synchronous write failure without leaving a pending timeout', async () => {
    vi.useFakeTimers();
    const s = transport();
    vi.spyOn(s.child.stdin, 'write').mockImplementation(() => { throw new Error('broken write'); });
    await expect(s.client.request('thread/resume')).rejects.toThrow('broken write');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('processes the final response before closing an exhausted stdout stream', async () => {
    const s = transport();
    const result = s.client.request('account/read');
    s.child.stdout.end(JSON.stringify({ id: 1, result: { final: true } }) + '\n');
    await expect(result).resolves.toEqual({ final: true });
    await new Promise<void>(resolve => { s.client.onClosed(() => resolve()); });
    await expect(s.client.request('model/list')).rejects.toThrow('closed');
  });
});
