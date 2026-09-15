import { buildBridgeSystemPrompt } from '../../../src/agent/bridge-system-prompt';
import { describe, expect, it, vi } from 'vitest';
import { activeSystemPrompt } from '../../../src/conversation/presentation-context';
import { fixture, authorize } from '../space/helpers';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { AgentAdapter } from '../../../src/agent/types';
import { fixedAdapterRuntimeProvider } from '../../../src/runtime/runtime-provider';

describe('RunExecutor policy runtime options', () => {
  it('passes policy sandbox and permission mode into each agent run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-policy',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-policy',
      policy: policy({
        sandbox: 'workspace-write',
        permissionMode: 'acceptEdits',
      }),
    });

    expect(agent.runOptions[0]).toMatchObject({
      runId: 'run-policy',
      scopeId: 'scope-policy',
      sandbox: 'workspace-write',
      permissionMode: 'acceptEdits',
    });

    await collect(execution.subscribe());
  });
});

it('native tool authority is presented through preparation and iteration, and revoked on normal exit', async () => {
  const context = await authorize(fixture());
  const close = vi.fn();
  const prompts: Array<string | undefined> = [];
  const agent: AgentAdapter = new FakeAgentAdapter({ events: [] });
  agent.prepareRun = async () => { prompts.push(activeSystemPrompt()); };
  agent.run = options => ({ runId: options.runId,
    events: { async *[Symbol.asyncIterator]() { prompts.push(activeSystemPrompt()); yield { type: 'done' as const, terminationReason: 'normal' as const }; } },
    stop: async () => {}, waitForExit: async () => true,
  });
  const tools = { prepare: vi.fn(async () => ({ prompt: 'REQUEST-BOUND-TOOL', close })), close: async () => {} };
  const base = fixedAdapterRuntimeProvider(agent);
  const acquire = vi.fn(async input => ({ ...await base.acquire(input), instructions: 'SHORT-WORKSPACE-GUIDE' }));
  const executor = new RunExecutor({ agent, tools, runtimeProvider: { acquire, dispose: () => base.dispose() },
    pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns(), now: () => 1000 });
  const run = await executor.submit({ scopeId: 'scope', policy: policy(), spaceContext: context });
  await collect(run.subscribe());
  expect(prompts).toHaveLength(2); expect(prompts.every(prompt => prompt?.includes('REQUEST-BOUND-TOOL'))).toBe(true);
  expect(prompts.every(prompt => prompt?.split('SHORT-WORKSPACE-GUIDE').length === 2)).toBe(true);
  expect(acquire.mock.calls[0]![0]).toMatchObject({ purpose: 'run', runId: run.runId });
  expect(close).toHaveBeenCalledTimes(1);
  expect(activeSystemPrompt()).toBeUndefined();
  await base.dispose();
});

it('native tool authority is revoked when engine preparation fails, releasing capacity for retry', async () => {
  const context = await authorize(fixture());
  const close = vi.fn();
  const agent: AgentAdapter = new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] });
  agent.prepareRun = vi.fn().mockRejectedValueOnce(new Error('native startup failed')).mockResolvedValue(undefined);
  const executor = new RunExecutor({ agent, tools: { prepare: async () => ({ prompt: 'request-tool', close }), close: async () => {} },
    pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns(), now: () => 1000 });
  const input = { scopeId: 'scope', policy: policy(), spaceContext: context };
  await expect(executor.submit(input)).rejects.toThrow('agent prepare failed');
  expect(close).toHaveBeenCalledTimes(1);
  const run = await executor.submit(input); await collect(run.subscribe());
  expect(close).toHaveBeenCalledTimes(2);
});

function policy(overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: '/tmp/repo',
    cwdRealpath: '/tmp/repo',
    accessMode: 'workspace',
    sandbox: 'workspace-write',
    permissionMode: 'acceptEdits',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}


it('keeps self identity in isolated presentation and snapshots it before asynchronous preparation', async () => {
  const context = await authorize(fixture());
  const identity = { providerId: 'lark', accountId: 'app', subjectId: 'jack', displayName: 'Jack' };
  const prompts: string[] = [];
  const agent: AgentAdapter = new FakeAgentAdapter();
  agent.prepareRun = async options => {
    identity.subjectId = 'alice'; identity.displayName = 'Alice';
    await Promise.resolve();
    prompts.push(buildBridgeSystemPrompt(options.identity));
  };
  agent.run = options => ({ runId: options.runId,
    events: { async *[Symbol.asyncIterator]() {
      prompts.push(buildBridgeSystemPrompt(options.identity));
      yield { type: 'done' as const, terminationReason: 'normal' as const };
    } }, stop: async () => {}, waitForExit: async () => true,
  });
  const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns(), now: () => 1000 });
  const run = await executor.submit({ scopeId: 'isolated', policy: policy(), identity, spaceContext: context, threadId: 'existing-thread' });
  await collect(run.subscribe());
  expect(prompts).toHaveLength(2);
  for (const prompt of prompts) {
    expect(prompt).toContain('Jack'); expect(prompt).not.toContain('Alice');
    expect(prompt).toContain('独立工作目录'); expect(prompt).not.toContain('飞书 OAuth');
    expect(prompt.split('当前身份（你）')).toHaveLength(2);
  }
});

it('keeps concurrent identities separate and does not inherit them into an unidentified run', async () => {
  const prompts = new Map<string, string>();
  const agent: AgentAdapter = new FakeAgentAdapter();
  agent.run = options => ({ runId: options.runId,
    events: { async *[Symbol.asyncIterator]() {
      await new Promise(resolve => setTimeout(resolve, options.scopeId === 'jack' ? 5 : 0));
      prompts.set(options.scopeId, buildBridgeSystemPrompt(options.identity));
      yield { type: 'done' as const, terminationReason: 'normal' as const };
    } }, stop: async () => {}, waitForExit: async () => true,
  });
  const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 3), activeRuns: new ActiveRuns(), now: () => 1000 });
  await Promise.all(['jack', 'alice', 'anonymous'].map(async scopeId => {
    const run = await executor.submit({ scopeId, policy: policy(),
      identity: scopeId === 'anonymous' ? undefined : { providerId: 'web', accountId: 'workspace', subjectId: scopeId },
      observability: { source: 'web', profile: 'test', agent: 'fake', stage: 'submit' },
    });
    await collect(run.subscribe());
  }));
  expect(prompts.get('jack')).toContain('jack'); expect(prompts.get('jack')).not.toContain('alice');
  expect(prompts.get('alice')).toContain('alice'); expect(prompts.get('alice')).not.toContain('jack');
  expect(prompts.get('anonymous')).not.toContain('当前身份（你）');
  expect([...prompts.values()].every(p => !p.includes('飞书 OAuth'))).toBe(true);
});
