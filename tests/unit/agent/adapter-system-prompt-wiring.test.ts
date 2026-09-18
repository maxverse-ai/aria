import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { buildBridgeSystemPrompt } from '../../../src/agent/bridge-system-prompt';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

describe('ClaudeAdapter system prompt wiring', () => {
  it('appends the identity-aware bridge system prompt via a temp file from the run identity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();

    adapter.run({ identity: { providerId: 'lark', accountId: 'app', subjectId: 'ou_bot_self', displayName: 'Bridge' }, runId: 'r1', scopeId: 'scope-test', prompt: 'hi', cwd: '/tmp' });

    // The prompt goes via stdin as a stream-json user line, never argv
    // (cmd.exe would mangle it on Windows). stdin stays open for steering.
    expect(await readPromptText(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(
      buildBridgeSystemPrompt(
        { providerId: 'lark', accountId: 'app', subjectId: 'ou_bot_self', displayName: 'Bridge' },
        { steerMailbox: true },
      ),
    );
    // delivery:'none' engines compose the notice+pull contract in.
    expect(systemPromptFileContent()).toContain('## Steer 信箱');
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();

    adapter.run({ runId: 'r1', scopeId: 'scope-test', prompt: 'hi', cwd: '/tmp' });

    expect(await readPromptText(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(buildBridgeSystemPrompt(undefined, { steerMailbox: true }));
  });

  function systemPromptFileContent(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--append-system-prompt-file');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args).not.toContain('--append-system-prompt');
    return readFileSync(args[flagIndex + 1] as string, 'utf8');
  }
});

async function readPromptText(stream: PassThrough): Promise<string> {
  const line = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for stdin line')), 5000);
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      resolve(buf.slice(0, nl));
    });
    stream.on('error', reject);
  });
  const event = JSON.parse(line) as { type: string; message?: { content?: Array<{ type: string; text?: string }> } };
  expect(event.type).toBe('user');
  const texts = (event.message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '');
  return texts.join('');
}
