import { describe, expect, it } from 'vitest';
import { bindAgentRun } from '../../../src/agent/runtime/bound-run';
import type { AgentRun } from '../../../src/agent/types';
import type { AgentSteeringSupport } from '../../../src/agent/steering';

describe('bindAgentRun', () => {
  it('preserves steering support negotiated after the run is bound', async () => {
    let support: AgentSteeringSupport | undefined;
    const native: AgentRun = {
      runId: 'run-1',
      events: (async function *() {
        yield { type: 'done', terminationReason: 'normal' };
      })(),
      get steering() {
        return support;
      },
      steer: async () => ({ kind: 'accepted', runId: 'run-1' }),
      stop: async () => undefined,
      waitForExit: async () => true,
    };
    const bound = bindAgentRun(native, (operation) => operation());

    expect(bound.steering).toBeUndefined();
    support = { mode: 'direct', textOnly: true };
    expect(bound.steering).toEqual(support);
    await expect(bound.steer!({
      requestId: 'steer-1',
      expectedRunId: 'run-1',
      prompt: 'change direction',
    })).resolves.toEqual({ kind: 'accepted', runId: 'run-1' });
  });
});
