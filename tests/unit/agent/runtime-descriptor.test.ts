import { describe, expect, it } from 'vitest';
import { createAdapterRuntime } from '../../../src/agent/runtime/adapter-runtime';
import {
  assertEngineRuntimeDescriptor,
  defineEngineRuntimeDescriptor,
} from '../../../src/agent/runtime/types';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

describe('engine runtime descriptor', () => {
  it('uses conservative semantic defaults for a one-shot adapter', () => {
    const runtime = createAdapterRuntime(new FakeAgentAdapter({ id: 'legacy' }));

    expect(runtime.descriptor).toEqual({
      contractVersion: 1,
      engineId: 'legacy',
      topology: 'one-shot',
      capabilities: {
        inputs: ['text'],
        liveInput: { mode: 'none', inputs: [] },
        sessions: [],
        controls: ['interrupt'],
        interactions: [],
        telemetry: [],
      },
    });
  });

  it('accepts native capabilities without exposing protocol method names', () => {
    const descriptor = defineEngineRuntimeDescriptor({
      engineId: 'native',
      topology: 'session-pool',
      capabilities: {
        inputs: ['text', 'image'],
        liveInput: { mode: 'gated', inputs: ['text'] },
        sessions: ['resume', 'list'],
        controls: ['interrupt', 'model', 'reasoning'],
        interactions: ['approval', 'question'],
        telemetry: ['usage', 'context'],
      },
    });

    expect(() => assertEngineRuntimeDescriptor(descriptor, 'native')).not.toThrow();
    expect(JSON.stringify(descriptor)).not.toMatch(/turn\/steer|session\/prompt|JSON-RPC/i);
  });

  it('rejects inconsistent live-input declarations', () => {
    expect(() => defineEngineRuntimeDescriptor({
      engineId: 'invalid',
      topology: 'profile-daemon',
      capabilities: {
        inputs: ['text'],
        liveInput: { mode: 'direct', inputs: ['image'] },
      },
    })).toThrow(/live inputs must also be declared as inputs/);
  });

  it('rejects a descriptor owned by a different adapter', () => {
    const descriptor = defineEngineRuntimeDescriptor({
      engineId: 'other',
      topology: 'one-shot',
    });

    expect(() => createAdapterRuntime(
      new FakeAgentAdapter({ id: 'legacy' }),
      descriptor,
    )).toThrow(/does not match adapter/);
  });
});
