import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), select: vi.fn(), powershell: vi.fn(), spawn: vi.fn(), write: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawn }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), rm: vi.fn(), writeFile: mocks.write }));
vi.mock('../../../src/daemon/windows-autostart', () => ({
  readWindowsTaskStatus: mocks.read, selectAutostartMode: mocks.select,
  runTaskPowerShell: mocks.powershell, bootTaskScript: () => 'interactive-registration', logonTaskScript: () => 'logon-registration',
}));
const { installTask } = await import('../../../src/daemon/schtasks');
const launchSpec = { runtimePath: 'C:\\node.exe', bridgeEntryPath: 'C:\\aria.mjs' };

describe('Windows task installation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.read.mockReturnValue({ installed: true, mode: 'boot', enabled: true, currentUser: 'HOST\\user', logonType: 'Password' });
    mocks.select.mockReturnValue('preserve');
    mocks.spawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mocks.powershell.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  it('refreshes the launcher without replacing an existing task or saved credentials', async () => {
    expect((await installTask('codex', ['run', '--profile', 'codex'], launchSpec)).ok).toBe(true);
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.powershell).not.toHaveBeenCalled();
  });

  it('does not mutate the launcher when explicit boot prerequisites fail', async () => {
    mocks.select.mockImplementationOnce(() => { throw new Error('Administrator required'); });
    await expect(installTask('codex', ['run'], launchSpec, 'boot')).rejects.toThrow('Administrator');
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('never falls back to logon on a boot registration error or explicit cancellation', async () => {
    mocks.select.mockReturnValue('boot');
    for (const [status, mode] of [[1, 'auto'], [2, 'boot']] as const) {
      mocks.powershell.mockReturnValue({ status });
      await expect(installTask('codex', ['run'], launchSpec, mode)).rejects.toThrow(/No logon fallback/);
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('allows auto mode to fall back to verified logon setup on credential cancellation', async () => {
    mocks.select.mockReturnValue('boot');
    mocks.powershell.mockReturnValueOnce({ status: 2 }).mockReturnValueOnce({ status: 0 });
    mocks.read.mockReturnValue({ installed: true, mode: 'logon', enabled: true });
    expect((await installTask('codex', ['run'], launchSpec)).ok).toBe(true);
    expect(mocks.powershell).toHaveBeenLastCalledWith('logon-registration');
  });

  it('does not report successful registration when Windows rejects the task', async () => {
    mocks.select.mockReturnValue('logon');
    mocks.powershell.mockReturnValue({ status: 1, stdout: '', stderr: 'Access denied' });
    expect(await installTask('codex', ['run'], launchSpec)).toMatchObject({ ok: false, stderr: 'Access denied' });
  });

  it('verifies unattended boot registration before reporting success', async () => {
    mocks.select.mockReturnValue('boot');
    mocks.powershell.mockReturnValue({ status: 0 });
    mocks.read.mockReturnValueOnce({ currentUser: 'HOST\\user' }).mockReturnValueOnce({ installed: true, mode: 'logon', enabled: true });
    await expect(installTask('codex', ['run'], launchSpec)).rejects.toThrow(/could not be verified/);
  });
});
