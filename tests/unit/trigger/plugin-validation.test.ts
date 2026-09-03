import { describe, expect, it } from 'vitest';
import { assertResolvedTriggerInstance, assertTriggerEnvelope, assertTriggerProviderManifest } from '../../../src/trigger/plugin';
import { createFakeTriggerProvider, fakeTriggerEnvelope, fakeTriggerInstance } from '../../fixtures/trigger/fake-trigger-provider';

describe('Trigger Provider ABI validation', () => {
  it('rejects executable fields at the provider boundary', () => {
    expect(() => assertTriggerEnvelope({ ...fakeTriggerEnvelope(), prompt: 'run arbitrary work' })).toThrow(/unsupported field: prompt/);
  });

  it('rejects non-JSON config and cyclic event data', () => {
    expect(() => assertResolvedTriggerInstance(fakeTriggerInstance({ config: { label: 'clock', bad: undefined } as never }))).toThrow(/JSON-serializable/);
    const envelope = fakeTriggerEnvelope();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    envelope.data = cyclic as never;
    expect(() => assertTriggerEnvelope(envelope)).toThrow(/must not be cyclic/);
  });

  it('requires cursors only when the provider declares cursor replay', () => {
    const capabilities = { ...createFakeTriggerProvider().manifest.capabilities, replay: 'cursor' as const };
    expect(() => assertTriggerEnvelope(fakeTriggerEnvelope(), undefined, capabilities)).toThrow(/must include an envelope cursor/);
  });

  it('rejects undeclared manifest fields', () => {
    expect(() => assertTriggerProviderManifest({ ...createFakeTriggerProvider().manifest, executeAgent: true })).toThrow(/unsupported field/);
  });
});
