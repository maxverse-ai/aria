import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeEngineStatus } from '../../../src/agent/plugin/probe.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';

const ENV_KEYS = [
  'LARK_CHANNEL_CLAUDE_BIN',
  'LARK_CHANNEL_CODEX_BIN',
  'LARK_CHANNEL_GROK_BIN',
  'LARK_CHANNEL_OPENCODE_BIN',
  'LARK_CHANNEL_DSH_BIN',
  'LARK_CHANNEL_KIMI_BIN',
  'LARK_CHANNEL_PI_BIN',
] as const;

describe('engine probe', () => {
  const savedEnv = new Map<string, string | undefined>();

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  it('reports installed engines with versions via env overrides', async () => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    const dir = await mkdtemp(join(tmpdir(), 'plugin-probe-'));
    try {
      process.env.LARK_CHANNEL_CLAUDE_BIN = await writeVersionExecutable(dir, 'claude', '2.1.0');
      process.env.LARK_CHANNEL_CODEX_BIN = await writeVersionExecutable(dir, 'codex', '0.149.0');
      process.env.LARK_CHANNEL_GROK_BIN = await writeVersionExecutable(dir, 'grok', '1.0.13');
      process.env.LARK_CHANNEL_OPENCODE_BIN = await writeVersionExecutable(
        dir,
        'opencode',
        '1.18.21',
      );
      process.env.LARK_CHANNEL_DSH_BIN = await writeVersionExecutable(dir, 'dsh', '0.1.1');
      process.env.LARK_CHANNEL_KIMI_BIN = await writeVersionExecutable(dir, 'kimi', '0.36.1');
      process.env.LARK_CHANNEL_PI_BIN = await writeVersionExecutable(dir, 'pi', '0.84.2');

      const statuses = await probeEngineStatus(true);
      const byId = new Map(statuses.map((s) => [s.id, s]));

      expect(byId.get('claude')).toMatchObject({ installed: true, version: '2.1.0' });
      expect(byId.get('codex')).toMatchObject({ installed: true, version: '0.149.0' });
      expect(byId.get('grok')).toMatchObject({ installed: true, version: '1.0.13' });
      expect(byId.get('opencode')).toMatchObject({ installed: true, version: '1.18.21' });
      expect(byId.get('dsh')).toMatchObject({ installed: true, version: '0.1.1' });
      expect(byId.get('kimi')).toMatchObject({ installed: true, version: '0.36.1' });
      expect(byId.get('pi')).toMatchObject({ installed: true, version: '0.84.2' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports missing engines as not installed', async () => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    process.env.LARK_CHANNEL_CLAUDE_BIN = '/nonexistent/claude-missing';
    process.env.LARK_CHANNEL_CODEX_BIN = '/nonexistent/codex-missing';
    process.env.LARK_CHANNEL_GROK_BIN = '/nonexistent/grok-missing';
    process.env.LARK_CHANNEL_OPENCODE_BIN = '/nonexistent/opencode-missing';
    process.env.LARK_CHANNEL_DSH_BIN = '/nonexistent/dsh-missing';
    process.env.LARK_CHANNEL_KIMI_BIN = '/nonexistent/kimi-missing';
    process.env.LARK_CHANNEL_PI_BIN = '/nonexistent/pi-missing';

    const statuses = await probeEngineStatus(true);
    for (const status of statuses) {
      expect(status.installed).toBe(false);
    }
  });
});
