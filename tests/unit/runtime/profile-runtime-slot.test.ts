import { describe, expect, it } from 'vitest';
import type { EngineRuntime } from '../../../src/agent/runtime/types';
import { ProfileRuntimeSlot } from '../../../src/runtime/profile-runtime-slot';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

describe('ProfileRuntimeSlot', () => {
  it('routes a stable adapter to the new runtime and carries bot identity across', () => {
    const first = runtime('first');
    const second = runtime('second');
    const slot = new ProfileRuntimeSlot(first);
    const stableAdapter = slot.execution;

    stableAdapter.setBotIdentity?.({ openId: 'ou_bot', name: 'Aria' });
    expect(stableAdapter.id).toBe('first');

    expect(slot.swap(second)).toBe(first);
    expect(slot.execution).toBe(stableAdapter);
    expect(stableAdapter.id).toBe('second');
    expect(slot.currentGeneration()).toBe(2);
    expect((second.execution as FakeAgentAdapter).botIdentity).toEqual({
      openId: 'ou_bot',
      name: 'Aria',
    });
  });

  it('caches and coalesces engine status snapshots per runtime generation', async () => {
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runtime('first');
    first.statusSnapshot = async () => {
      calls++;
      await pending;
      return { model: 'first-model', updatedAt: Date.now() };
    };
    const slot = new ProfileRuntimeSlot(first);

    const left = slot.statusSnapshot();
    const right = slot.statusSnapshot();
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([left, right])).resolves.toEqual([
      expect.objectContaining({ model: 'first-model' }),
      expect.objectContaining({ model: 'first-model' }),
    ]);
    await slot.statusSnapshot();
    expect(calls).toBe(1);

    const second = runtime('second');
    second.statusSnapshot = async () => {
      calls++;
      return { model: 'second-model', updatedAt: Date.now() };
    };
    slot.swap(second);
    await expect(slot.statusSnapshot()).resolves.toMatchObject({ model: 'second-model' });
    expect(calls).toBe(2);
  });
});

function runtime(id: string): EngineRuntime {
  return {
    engineId: id,
    execution: new FakeAgentAdapter({ id, displayName: id }),
    dispose: async () => undefined,
  };
}
