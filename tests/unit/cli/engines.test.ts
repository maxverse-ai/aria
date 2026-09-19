import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatEngines, runEngines } from '../../../src/cli/commands/engines';
import { listEnginePlugins } from '../../../src/agent/plugin/registry';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('engines CLI handler', () => {
  it('prints every registered engine plugin id as stable JSON', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runEngines({ json: true });

    expect(output).toHaveBeenCalledOnce();
    const snapshot = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(snapshot.schema).toBe('aria.engines.v1');
    const ids = snapshot.engines.map((engine: { id: string }) => engine.id);
    expect(ids).toEqual(listEnginePlugins().map((plugin) => plugin.id));
    expect(snapshot.engines[0]).toMatchObject({
      id: expect.any(String),
      displayName: expect.any(String),
      sessionKind: expect.any(String),
    });
  });

  it('renders detection state in text output', () => {
    const text = formatEngines({
      schema: 'aria.engines.v1',
      apiVersion: 1,
      engines: [
        {
          id: 'claude',
          displayName: 'Claude Code',
          sessionKind: 'session',
          supportsNativeHistory: true,
          defaultBinary: 'claude',
          detectedBinary: '/usr/bin/claude',
          automationCapabilities: [],
        },
      ],
    });
    expect(text).toContain('claude');
    expect(text).toContain('/usr/bin/claude');
  });
});
