import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatTriggerCapabilities,
  runTriggerCapabilities,
  runTriggerExecute,
  runTriggerList,
  runTriggerSchema,
} from '../../../src/cli/commands/trigger';
import { triggerCapabilities } from '../../../src/application/execution-intent';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('trigger contract CLI', () => {
  it('prints stable machine-readable capability JSON', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runTriggerCapabilities({ json: true });

    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      schema: 'aria.trigger.capabilities.v1',
      apiVersion: 1,
      implementationStage: 'unified-operations',
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
      'runtime: disabled by default (enable with ARIA_TRIGGER_RUNTIME=enabled)',
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

  it('refuses one-shot mutations unless the operator explicitly confirms them', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'aria-trigger-cli-'));
    roots.push(rootDir);

    await expect(runTriggerExecute('create', { rootDir, input: '{}' })).rejects.toThrow(
      'mutation requires --yes',
    );
  });

  it('creates and reads definitions through the management API adapter', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'aria-trigger-cli-'));
    roots.push(rootDir);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runTriggerExecute('create', {
      rootDir,
      yes: true,
      json: true,
      input: JSON.stringify({
        profileId: 'profile-a',
        ownerRef: 'owner-a',
        prompt: 'prepare the report',
        schedule: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() },
      }),
    });
    await runTriggerList({ rootDir, json: true });

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      schema: 'aria.trigger-management.apply.v1',
      command: 'create',
      definition: { profileId: 'profile-a', state: 'active' },
    });
    expect(JSON.parse(String(output.mock.calls[1]?.[0]))).toMatchObject({
      schema: 'aria.trigger-read.snapshot.v1',
      definitions: [{ profileId: 'profile-a' }],
    });
  });
});
