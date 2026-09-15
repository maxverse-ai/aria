import { describe, expect, it, vi } from 'vitest';
import { confineSpawn, withConfinedLaunch, type ConfinedLaunch } from '../../../src/space/launch';
import { resolveSpacePaths } from '../../../src/space/paths';
import type { ExecutionEnvironment } from '../../../src/execution/types';

const paths = resolveSpacePaths('/private/profile', { kind: 'default', profileId: 'profile' });
function fixture() {
  const prepare = vi.fn<ExecutionEnvironment['prepare']>(request => ({
    command: '/manager/runtime', args: ['exec', request.command, ...request.args],
    cwd: '/manager', env: { HOME: '/manager' },
  }));
  const launch: ConfinedLaunch = {
    binary: '/usr/bin/agent', paths, workspaceAccess: 'workspace', executableRoots: [], environment: {}, driver: 'execution',
    executionEnvironment: { id: 'test-space', prepare, close: async () => {} },
  };
  return { prepare, launch };
}
describe('execution backend at native launch boundary', () => {
  it('passes package configuration into the owned container while excluding ambient manager state', () => {
    const f = fixture();
    const launch = {...f.launch,environment:{EXAMPLE_CONFIG:paths.home+'/example',LARK_CHANNEL:'1',LARK_CHANNEL_PROFILE:'space'}};
    withConfinedLaunch(launch, () => confineSpawn('/usr/bin/agent', [], {env:{EXAMPLE_CONFIG:'/manager/private',CONTAINER_HOST:'private-socket'}}));
    const env = f.prepare.mock.calls[0]![0].env;
    expect(env.EXAMPLE_CONFIG).toBe(paths.home+'/example');
    expect(env.LARK_CHANNEL_PROFILE).toBe('space');
    expect(env).not.toHaveProperty('CONTAINER_HOST');
  });

  it('delegates both command and manager environment while retaining admission checks', () => {
    const f = fixture();
    const result = withConfinedLaunch(f.launch, () => confineSpawn('/usr/bin/agent', ['query'], {
      cwd: paths.workspace, env: { HOME: '/foreign', PRIVATE_MANAGER_TOKEN: 'not-in-task' }, stdio: 'pipe',
    }));
    expect(result.command).toBe('/manager/runtime');
    expect(result.options.env).toEqual({ HOME: '/manager' });
    expect(result.options.stdio).toBe('pipe');
    expect(f.prepare.mock.calls[0]![0].env.HOME).toBe(paths.home);
    expect(f.prepare.mock.calls[0]![0].env).not.toHaveProperty('PRIVATE_MANAGER_TOKEN');
    expect(() => withConfinedLaunch(f.launch, () => confineSpawn('/bin/sh', [], {}))).toThrow('admitted');
    expect(() => withConfinedLaunch(f.launch, () => confineSpawn('/usr/bin/agent', [], { shell: true }))).toThrow('host shell');
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it('never falls back to host execution when a backend refuses a command', () => {
    const f = fixture(); f.prepare.mockImplementation(() => { throw new Error('environment unavailable'); });
    expect(() => withConfinedLaunch({ ...f.launch, driver: 'trusted-process' },
      () => confineSpawn('/usr/bin/agent', [], {}))).toThrow('environment unavailable');
  });
  it('keeps nested launches and later async calls in their own acquired environments', async () => {
    const a = fixture(), b = fixture();
    await withConfinedLaunch(a.launch, async () => {
      await Promise.resolve();
      withConfinedLaunch(b.launch, () => confineSpawn('/usr/bin/agent', ['b'], {}));
      confineSpawn('/usr/bin/agent', ['a'], {});
    });
    expect(a.prepare.mock.calls[0]![0].args).toEqual(['a']);
    expect(b.prepare.mock.calls[0]![0].args).toEqual(['b']);
    expect(confineSpawn('/bin/true', [], {}).command).toBe('/bin/true');
  });
});
