import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  'LARK_CHANNEL_MIMO_BIN',
  'LARK_CHANNEL_DSH_BIN',
  'LARK_CHANNEL_KIMI_BIN',
  'LARK_CHANNEL_PI_BIN',
  'LARK_CHANNEL_DEVIN_BIN',
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
      process.env.LARK_CHANNEL_MIMO_BIN = await writeVersionExecutable(dir, 'mimo', '0.9.0');
      process.env.LARK_CHANNEL_DSH_BIN = await writeVersionExecutable(dir, 'dsh', '0.1.1');
      process.env.LARK_CHANNEL_KIMI_BIN = await writeVersionExecutable(dir, 'kimi', '0.36.1');
      process.env.LARK_CHANNEL_PI_BIN = await writeVersionExecutable(dir, 'pi', '0.84.2');
      process.env.LARK_CHANNEL_DEVIN_BIN = await writeVersionExecutable(dir, 'devin', '3000.10.31');

      const statuses = await probeEngineStatus(true);
      const byId = new Map(statuses.map((s) => [s.id, s]));

      expect(byId.get('claude')).toMatchObject({ installed: true, version: '2.1.0' });
      expect(byId.get('codex')).toMatchObject({ installed: true, version: '0.149.0' });
      expect(byId.get('grok')).toMatchObject({ installed: true, version: '1.0.13' });
      expect(byId.get('opencode')).toMatchObject({ installed: true, version: '1.18.21' });
      expect(byId.get('mimo')).toMatchObject({ installed: true, version: '0.9.0' });
      expect(byId.get('dsh')).toMatchObject({ installed: true, version: '0.1.1' });
      expect(byId.get('kimi')).toMatchObject({ installed: true, version: '0.36.1' });
      expect(byId.get('pi')).toMatchObject({ installed: true, version: '0.84.2' });
      expect(byId.get('devin')).toMatchObject({ installed: true, version: '3000.10.31' });
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
    process.env.LARK_CHANNEL_MIMO_BIN = '/nonexistent/mimo-missing';
    process.env.LARK_CHANNEL_DSH_BIN = '/nonexistent/dsh-missing';
    process.env.LARK_CHANNEL_KIMI_BIN = '/nonexistent/kimi-missing';
    process.env.LARK_CHANNEL_PI_BIN = '/nonexistent/pi-missing';
    process.env.LARK_CHANNEL_DEVIN_BIN = '/nonexistent/devin-missing';

    const statuses = await probeEngineStatus(true);
    for (const status of statuses) {
      expect(status.installed).toBe(false);
    }
  });

  it('records why a present engine reported no version', async () => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    const dir = await mkdtemp(join(tmpdir(), 'plugin-probe-failure-'));
    try {
      const fake = async (name: string, body: string): Promise<string> => {
        const file = join(dir, name);
        await writeFile(file, `#!${process.execPath}\n${body}\n`);
        await chmod(file, 0o755);
        return file;
      };
      const missing = (name: string): string => join(dir, `${name}-missing`);
      process.env.LARK_CHANNEL_CLAUDE_BIN = missing('claude');
      process.env.LARK_CHANNEL_CODEX_BIN = missing('codex');
      process.env.LARK_CHANNEL_GROK_BIN = await fake('grok', 'console.error("boom"); process.exit(3);');
      process.env.LARK_CHANNEL_OPENCODE_BIN = await fake('opencode', 'process.exit(0);');
      process.env.LARK_CHANNEL_MIMO_BIN = missing('mimo');
      process.env.LARK_CHANNEL_DSH_BIN = missing('dsh');
      process.env.LARK_CHANNEL_KIMI_BIN = missing('kimi');
      process.env.LARK_CHANNEL_PI_BIN = missing('pi');
      process.env.LARK_CHANNEL_DEVIN_BIN = missing('devin');

      const byId = new Map((await probeEngineStatus(true)).map((status) => [status.id, status]));

      // The binary exists, so it stays "installed"; the reason it has no version
      // is what an intermittent failure needs to be diagnosable.
      expect(byId.get('grok')).toMatchObject({ installed: true, version: undefined });
      expect(byId.get('grok')?.error).toContain('exited with code 3');
      expect(byId.get('grok')?.error).toContain('boom');
      expect(byId.get('opencode')).toMatchObject({ installed: true, version: undefined });
      expect(byId.get('opencode')?.error).toContain('produced no output');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries a transient probe failure instead of reporting no version', async () => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    const dir = await mkdtemp(join(tmpdir(), 'plugin-probe-retry-'));
    try {
      const missing = (name: string): string => join(dir, `${name}-missing`);
      for (const key of ENV_KEYS) process.env[key] = missing(key);
      // Fails the first time it runs, succeeds afterwards.
      const marker = join(dir, 'ran');
      const flaky = join(dir, 'flaky');
      await writeFile(flaky, `#!${process.execPath}\n`
        + 'const fs = require("node:fs");\n'
        + `if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, "1"); process.exit(7); }\n`
        + 'console.log("2.5.0");\n');
      await chmod(flaky, 0o755);
      process.env.LARK_CHANNEL_CLAUDE_BIN = flaky;

      const byId = new Map((await probeEngineStatus(true)).map((status) => [status.id, status]));

      expect(byId.get('claude')).toMatchObject({ installed: true, version: '2.5.0' });
      expect(byId.get('claude')?.error).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
