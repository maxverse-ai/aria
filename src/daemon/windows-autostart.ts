import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export type AutostartMode = 'auto' | 'logon' | 'boot';

export interface WindowsTaskStatus {
  installed: boolean;
  mode: 'boot' | 'logon' | 'unknown';
  enabled: boolean;
  running: boolean;
  account?: string;
  logonType?: string;
  elevated: boolean;
  currentUser: string;
}

// Only non-secret task metadata is embedded in scripts. Credentials never cross
// the PowerShell boundary (no argv, stdin JSON, temporary file, or Node heap).
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function runTaskPowerShell(script: string, interactive = false) {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawnSync(executable, [
    '-NoProfile', ...(interactive ? [] : ['-NonInteractive']),
    '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n${script}`, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, ...(interactive ? { stdio: 'inherit' as const } : {}) });
}

/** COM/XML avoids parsing localized schtasks output (e.g. Chinese Windows). */
export function taskStatusScript(taskName: string): string {
  return `
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$task = $null
try { $task = $service.GetFolder('\\').GetTask(${literal(taskName)}) }
catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
$mode = 'unknown'
$account = $null
$logonType = $null
if ($null -ne $task) {
  [xml]$xml = $task.Xml
  if ($null -ne $xml.Task.Triggers.BootTrigger) { $mode = 'boot' }
  elseif ($null -ne $xml.Task.Triggers.LogonTrigger) { $mode = 'logon' }
  $account = [string]$xml.Task.Principals.Principal.UserId
  $logonType = [string]$xml.Task.Principals.Principal.LogonType
}
[pscustomobject]@{
  installed = ($null -ne $task); mode = $mode
  enabled = ($null -ne $task -and $task.Enabled)
  running = ($null -ne $task -and $task.State -eq 4)
  account = $account; logonType = $logonType
  elevated = $elevated; currentUser = $identity.Name
} | ConvertTo-Json -Compress
`;
}

export function readWindowsTaskStatus(taskName: string): WindowsTaskStatus {
  const result = runTaskPowerShell(taskStatusScript(taskName));
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Cannot inspect Windows scheduled task; existing registration was not replaced.');
  const status = JSON.parse(result.stdout.trim()) as WindowsTaskStatus;
  if (typeof status.installed !== 'boolean' || typeof status.elevated !== 'boolean' || !status.currentUser) {
    throw new Error('Invalid Windows scheduled task status; existing registration was not replaced.');
  }
  status.account ||= undefined;
  status.logonType ||= undefined;
  return status;
}

export function selectAutostartMode(
  requested: AutostartMode,
  status: WindowsTaskStatus,
  interactive: boolean,
): 'preserve' | 'boot' | 'logon' {
  if (requested === 'auto' && status.installed) return 'preserve';
  if (requested === 'boot' && status.installed && status.mode === 'boot' &&
      ['Password', 'S4U', 'ServiceAccount'].includes(status.logonType ?? '')) return 'preserve';
  if (requested === 'boot') {
    if (!status.elevated || !interactive) {
      throw new Error('Boot autostart requires an Administrator terminal and interactive Windows account password input. Run aria start --autostart boot locally as Administrator. Existing task was preserved.');
    }
    return 'boot';
  }
  if (requested === 'logon') return 'logon';
  return status.elevated && interactive ? 'boot' : 'logon';
}

export function bootTaskScript(taskName: string, launcher: string, workingDirectory: string, account: string): string {
  return `
$account = ${literal(account)}
Write-Host 'Aria: configure startup before Windows sign-in. Enter the Windows account password, not the Windows Hello PIN. Cancel to skip.'
$credential = Get-Credential -UserName $account -Message 'Aria boot autostart: Windows account password'
if ($null -eq $credential) { exit 2 }
if ($credential.UserName -ine $account) { throw 'Use the same Windows account as the Aria installation.' }
$plainPassword = $null
try {
  $plainPassword = $credential.GetNetworkCredential().Password
  if ([string]::IsNullOrEmpty($plainPassword)) { exit 2 }
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\cmd.exe" -Argument ${literal(`/d /c ""${launcher}""`)} -WorkingDirectory ${literal(workingDirectory)}
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $trigger.Delay = 'PT60S'
  $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Password -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Aria boot autostart; runs before Windows sign-in.'
  Register-ScheduledTask -TaskName ${literal(taskName)} -InputObject $definition -User $account -Password $plainPassword -Force | Out-Null
} finally { $plainPassword = $null; $credential = $null }
`;
}

export function logonTaskScript(taskName: string, launcher: string, workingDirectory: string, account: string): string {
  return `
$account = ${literal(account)}
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\cmd.exe" -Argument ${literal(`/d /c ""${launcher}""`)} -WorkingDirectory ${literal(workingDirectory)}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Aria logon autostart; sign in to Windows to start.'
Register-ScheduledTask -TaskName ${literal(taskName)} -InputObject $definition -Force | Out-Null
`;
}
