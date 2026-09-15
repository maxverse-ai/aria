import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelEnvContext } from '../../../src/agent/channel-env';
import { defineEngineRuntimeFactory } from '../../../src/agent/runtime/construction';
import { createAdapterRuntime } from '../../../src/agent/runtime/adapter-runtime';
import { normalizeEngineProfileConfig } from '../../../src/config/profile-schema';
import { prepareProfileEngineRuntime } from '../../../src/runtime/agent-runtime';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

const engines = ['claude', 'codex', 'grok', 'opencode', 'dsh', 'kimi', 'pi'];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runtime construction preparation', () => {
  it.each(engines)('prepares %s without creating state, changing config or starting a process', async (id) => {
    const root = await mkdtemp(join(tmpdir(), 'aria-runtime-prepare-'));
    roots.push(root);
    const profile = normalizeEngineProfileConfig({
      schemaVersion: 2,
      agentKind: id,
      ...(id === 'claude' ? {} : { [id]: { binaryPath: join(root, 'not-an-executable') } }),
    });
    const stored = JSON.stringify(profile);
    const configPath = join(root, 'config.json');
    await writeFile(configPath, stored);
    const paths = {
      profileDir: join(root, 'profile-state'),
      profile: 'default',
      rootDir: root,
      configPath,
    };
    const plan = prepareProfileEngineRuntime(profile, paths);
    expect(plan.context).toEqual({
      engineId: id,
      owner: { kind: 'profile', key: paths.profileDir },
      state: { directory: paths.profileDir },
      launch: { legacyChannel: { profile: 'default', rootDir: root, configPath } },
    });
    expect(Object.isFrozen(plan.context.launch.legacyChannel)).toBe(true);
    expect(Object.isFrozen(plan.context.owner)).toBe(true);
    expect(Object.isFrozen(plan.context.state)).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(profile.mode).toBe('personal');
    expect(JSON.stringify(profile)).toBe(stored);
    expect(await readdir(root)).toEqual(['config.json']);

    // Construction also preserves lazy daemon startup. An invalid executable
    // above would fail if either preparation or construction tried to spawn it.
    const runtime = plan.create();
    try {
      expect(runtime.engineId).toBe(id);
      expect(runtime.descriptor.contractVersion).toBe(1);
      expect(runtime.descriptor.topology).toBe(
        ['codex', 'grok'].includes(id) ? 'profile-daemon' : 'one-shot',
      );
      expect(await readdir(root)).toEqual(['config.json']);
      expect(await readFile(configPath, 'utf8')).toBe(stored);
    } finally {
      await runtime.dispose();
    }
  });

  it('takes an owned options snapshot before any native construction', async () => {
    const profile = normalizeEngineProfileConfig({ schemaVersion: 2, agentKind: 'claude' });
    const channel = { profile: 'one', rootDir: '/original', configPath: '/original/config.json' };
    const nativeOptions = { nested: { roots: ['/original'] }, translate: (s: string) => [s] };
    const construct = vi.fn((_options: {
      nested: { roots: string[] };
      translate: (s: string) => string[];
      channel?: Readonly<ChannelEnvContext>;
    }) => createAdapterRuntime(new FakeAgentAdapter()));
    const factory = defineEngineRuntimeFactory(
      'claude',
      (context) => ({ ...nativeOptions, channel: context.launch.legacyChannel }),
      construct,
    );
    const input = { profileConfig: profile, appPaths: { profileDir: '/original' }, ariaChannel: channel };
    const plan = factory.prepare(input);
    expect(construct).not.toHaveBeenCalled();
    nativeOptions.nested.roots.push('/later');
    channel.profile = 'two';
    input.appPaths.profileDir = '/later';
    const first = plan.create();
    const second = plan.create();
    try {
      expect(first).not.toBe(second);
      const options = construct.mock.calls[0]?.[0];
      expect(options).toMatchObject({ nested: { roots: ['/original'] }, channel: { profile: 'one' } });
      expect(options?.translate('high')).toEqual(['high']);
      expect(Object.isFrozen(options?.nested.roots)).toBe(true);
      expect(Object.isFrozen(nativeOptions.nested.roots)).toBe(false);
      expect(plan.context.state.directory).toBe('/original');
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it.each(['personal', 'team'])('preserves %s mode while preparing a channel-free worker', (mode) => {
    const profile = normalizeEngineProfileConfig({ schemaVersion: 2, agentKind: 'claude', mode });
    const before = structuredClone(profile);
    const plan = prepareProfileEngineRuntime(profile, { profileDir: '/worker-state' });
    expect(plan.context.launch).toEqual({});
    expect(plan.context.owner).toEqual({ kind: 'profile', key: '/worker-state' });
    expect(profile).toEqual(before);
    expect(profile).not.toHaveProperty('accounts');
  });

  it('preserves explicit config-path precedence and private CLI source binding', () => {
    const plan = prepareProfileEngineRuntime(
      normalizeEngineProfileConfig({ schemaVersion: 2, agentKind: 'claude' }),
      {
        profileDir: '/profile',
        rootDir: '/root',
        profile: 'example',
        configFile: '/fallback.json',
        configPath: '/explicit.json',
        larkCliConfigDir: '/private-cli',
        larkCliSourceConfigFile: '/private-source.json',
      },
    );
    expect(plan.context.launch.legacyChannel).toEqual({
      profile: 'example',
      rootDir: '/root',
      configPath: '/explicit.json',
      larkCliConfigDir: '/private-cli',
      larkCliSourceConfigFile: '/private-source.json',
    });
  });

  it.each(engines.filter((id) => id !== 'claude'))('rejects missing %s settings during preparation', (id) => {
    const profile = normalizeEngineProfileConfig({ schemaVersion: 2, agentKind: 'claude' });
    profile.agentKind = id;
    expect(() => prepareProfileEngineRuntime(profile, { profileDir: '/uncreated' }))
      .toThrow(id + ' profile requires ' + id + '.binaryPath');
  });
});
