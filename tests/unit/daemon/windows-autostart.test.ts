import { describe, expect, it } from 'vitest';
import { bootTaskScript, logonTaskScript, readWindowsTaskStatus, runTaskPowerShell, selectAutostartMode, taskStatusScript, type WindowsTaskStatus } from '../../../src/daemon/windows-autostart';

const absent: WindowsTaskStatus = {
  installed: false, mode: 'unknown', enabled: false, running: false,
  elevated: false, currentUser: 'HOST\\user',
};

describe('adaptive Windows autostart', () => {
  it('defaults to logon without elevation or an interactive terminal', () => {
    expect(selectAutostartMode('auto', absent, true)).toBe('logon');
    expect(selectAutostartMode('auto', { ...absent, elevated: true }, false)).toBe('logon');
    expect(selectAutostartMode('auto', { ...absent, elevated: true }, true)).toBe('boot');
  });

  it('never downgrades or prompts for credentials for an existing task in auto mode', () => {
    for (const mode of ['boot', 'logon', 'unknown'] as const) {
      expect(selectAutostartMode('auto', { ...absent, installed: true, mode }, false)).toBe('preserve');
    }
    expect(selectAutostartMode('boot', { ...absent, installed: true, mode: 'boot', logonType: 'Password' }, false)).toBe('preserve');
  });

  it('requires local credential input for a new boot task and does not silently downgrade explicit boot', () => {
    expect(() => selectAutostartMode('boot', absent, true)).toThrow(/Administrator/);
    expect(() => selectAutostartMode('boot', { ...absent, elevated: true }, false)).toThrow(/interactive/);
    expect(selectAutostartMode('logon', { ...absent, installed: true, mode: 'boot' }, false)).toBe('logon');
  });

  it('does not treat an interactive-token boot trigger as unattended boot setup', () => {
    expect(() => selectAutostartMode('boot', { ...absent, installed: true, mode: 'boot', logonType: 'InteractiveToken' }, false)).toThrow();
  });

  it('builds a password-backed task with recovery and quotes apostrophes in metadata', () => {
    const script = bootTaskScript('Aria.Bot.test', "C:\\O'Brien\\launcher.cmd", 'C:\\state', 'HOST\\user');
    expect(script).toContain("C:\\O''Brien\\launcher.cmd");
    expect(script).toContain('-LogonType Password -RunLevel Limited');
    expect(script).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)');
    expect(script).toContain('-MultipleInstances IgnoreNew');
    expect(script).toContain('-RestartCount 10');
    expect(script).toContain('New-ScheduledTaskTrigger -AtStartup');
    expect(script).toContain('Get-Credential');
    expect(script).not.toContain('ConvertFrom-SecureString');
    expect(script).not.toMatch(/Set-Content|WriteAllText|Out-File/);
  });
});

describe.skipIf(process.platform !== 'win32')('Windows read-only integration', () => {
  it('queries a missing task without modifying Task Scheduler', () => {
    const result = readWindowsTaskStatus(`Aria.Test.Absent.${process.pid}`);
    expect(result.installed).toBe(false);
    expect(result.running).toBe(false);
    expect(result.currentUser).toBeTruthy();
  });

  it('parses the boot registration script with the installed Windows PowerShell', () => {
    const script = bootTaskScript('Aria.Test.ParseOnly', 'C:\\state\\launcher.cmd', 'C:\\state', 'HOST\\user') + logonTaskScript('Aria.Test.ParseOnly', 'C:\\state\\launcher.cmd', 'C:\\state', 'HOST\\user');
    const source = Buffer.from(script, 'utf8').toString('base64');
    const result = runTaskPowerShell(`
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))
$tokens = $null; $errors = $null
$null = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(taskStatusScript('test')).not.toContain('/FO LIST');
  });
});
