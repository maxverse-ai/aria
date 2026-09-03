import { describe, expect, it, vi } from 'vitest';
import { TriggerProviderError, TriggerProviderRegistry } from '../../../src/trigger/plugin';
import { createFakeTriggerProvider, fakeTriggerEnvelope, fakeTriggerInstance } from '../../fixtures/trigger/fake-trigger-provider';

const context = (instance = fakeTriggerInstance(), accept = vi.fn(async () => ({ status: 'accepted' as const, receiptId: 'r-1' }))) => ({ instance, accept, value: { instance, signal: new AbortController().signal, ingress: { accept } } });

describe('TriggerProviderRegistry', () => {
  it('owns provider lifecycle and validates ingress', async () => {
    const close = vi.fn(async () => undefined);
    const provider = createFakeTriggerProvider({ emitOnStart: true, close });
    const registry = new TriggerProviderRegistry();
    registry.register(provider);
    const input = context();
    const runtime = await registry.start('fake-trigger', input.value);
    expect(input.accept).toHaveBeenCalledOnce();
    expect(runtime.snapshot().state).toBe('ready');
    expect((await runtime.health()).status).toBe('healthy');
    expect(await runtime.drain({ deadlineAt: Date.now() + 1000 })).toEqual({ drained: true, remainingEvents: 0 });
    await Promise.all([runtime.close(), runtime.close()]);
    expect(close).toHaveBeenCalledOnce();
    expect(registry.activeCount()).toBe(0);
  });

  it('rejects cross-instance events before core acceptance', async () => {
    const provider = createFakeTriggerProvider();
    const original = provider.start;
    provider.start = async (ctx) => {
      await ctx.ingress.accept(fakeTriggerEnvelope({ ...ctx.instance, instanceId: 'other' }));
      return original(ctx);
    };
    const registry = new TriggerProviderRegistry(); registry.register(provider);
    const input = context();
    await expect(registry.start('fake-trigger', input.value)).rejects.toThrow(/does not match/);
    expect(input.accept).not.toHaveBeenCalled();
  });

  it('rejects undeclared source kinds and invalid retry hints', async () => {
    const provider = createFakeTriggerProvider();
    const original = provider.start;
    provider.start = async (ctx) => {
      await ctx.ingress.accept({ ...fakeTriggerEnvelope(ctx.instance), sourceKind: 'webhook' });
      return original(ctx);
    };
    const registry = new TriggerProviderRegistry(); registry.register(provider);
    await expect(registry.start('fake-trigger', context().value)).rejects.toMatchObject({ kind: 'unsupported-capability' });
    expect(() => new TriggerProviderError('bad', { kind: 'permanent', code: 'bad', retryAfterMs: 1 })).toThrow(/transient/);
  });

  it('prevents duplicate and disabled starts', async () => {
    const provider = createFakeTriggerProvider(); const registry = new TriggerProviderRegistry();
    registry.register(provider); registry.register(provider);
    expect(() => registry.register(createFakeTriggerProvider())).toThrow(/already registered/);
    await expect(registry.start('fake-trigger', context(fakeTriggerInstance({ enabled: false })).value)).rejects.toThrow(/disabled/);
    const runtime = await registry.start('fake-trigger', context().value);
    await expect(registry.start('fake-trigger', context().value)).rejects.toThrow(/already active/);
    await runtime.close();
  });
});
