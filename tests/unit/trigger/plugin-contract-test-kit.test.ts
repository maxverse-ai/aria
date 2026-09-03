import { describe, expect, it, vi } from 'vitest';
import { runTriggerProviderContract } from '../../../src/trigger/plugin';
import { createFakeTriggerProvider, fakeTriggerInstance } from '../../fixtures/trigger/fake-trigger-provider';

describe('runTriggerProviderContract', () => {
  it('exercises ingress, health, drain and idempotent close', async () => {
    const close = vi.fn(async () => undefined);
    const result = await runTriggerProviderContract({ provider: createFakeTriggerProvider({ emitOnStart: true, close }), instance: fakeTriggerInstance() });
    expect(result.accepted).toHaveLength(1);
    expect(result.initialSnapshot.state).toBe('ready');
    expect(result.health.status).toBe('healthy');
    expect(result.drain.drained).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});
