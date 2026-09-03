import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatTriggerCapabilities,
  runTriggerCapabilities,
  runTriggerSchema,
} from '../../../src/cli/commands/trigger';
import { triggerCapabilities } from '../../../src/application/execution-intent';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('trigger contract CLI', () => {
  it('prints stable machine-readable capability JSON', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runTriggerCapabilities({ json: true });

    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      schema: 'aria.trigger.capabilities.v1',
      apiVersion: 1,
      implementationStage: 'result-routing',
      runtimeEnabled: false,
    });
  });

  it('prints a requested versioned contract schema as JSON', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runTriggerSchema('session-policy', { json: true });

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      schema: 'aria.trigger.contract-schema.v1',
      name: 'session-policy',
      contractVersion: 1,
      jsonSchema: { $id: 'aria.trigger.session-policy.v1' },
    });
  });

  it('makes the not-yet-shipped runtime explicit in text output', () => {
    expect(formatTriggerCapabilities(triggerCapabilities())).toContain(
      'runtime: disabled (durable state only; no scheduled execution is shipped)',
    );
  });

  it('publishes provider manifest and envelope schemas', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runTriggerSchema('trigger-envelope', { json: true });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      name: 'trigger-envelope',
      jsonSchema: { $id: 'aria.trigger.envelope.v1' },
    });
  });

  it('publishes durable definition and occurrence schemas', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runTriggerSchema('trigger-occurrence', { json: true });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      name: 'trigger-occurrence',
      jsonSchema: { $id: 'aria.trigger.occurrence.v1' },
    });
  });
});
