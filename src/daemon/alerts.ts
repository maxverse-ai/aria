import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnProcessSync } from '../platform/spawn';
import { redactDiagnosticText } from '../core/logger';

/** Explicit opt-in; never infer recipients from conversation history. A webhook
 * belongs to the operator and is not copied from a bot/account credential. */
export async function sendDaemonAlert(directory: string, text: string): Promise<void> {
  await mkdir(directory, {recursive: true});
  const safeText = redactDiagnosticText(text);
  await appendFile(join(directory, 'alerts.jsonl'), JSON.stringify({ts: new Date().toISOString(), text: safeText}) + '\n', {mode: 0o600});
  if (process.platform === 'win32') {
    const script = '$t=[Console]::In.ReadToEnd(); try {[System.Diagnostics.EventLog]::WriteEntry("Application",$t,[System.Diagnostics.EventLogEntryType]::Warning,4100)} catch {exit 1}';
    const result = spawnProcessSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script], {input: safeText, windowsHide: true, timeout: 5000, stdio: ['pipe', 'ignore', 'ignore']});
    if (result.status !== 0) await appendFile(join(directory, 'alerts.jsonl'), JSON.stringify({ts: new Date().toISOString(), event: 'windows-event-unavailable'}) + '\n');
  }
  let config: {webhookUrl?: string};
  try { config = JSON.parse(await readFile(join(directory, 'alerts.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Invalid daemon alerts.json'); }
  if (!config.webhookUrl) return;
  const url = new URL(config.webhookUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Daemon alert webhook requires HTTPS without URL user credentials');
  try {
    const response = await fetch(url, {method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({msg_type: 'text', content: {text: safeText}}), signal: AbortSignal.timeout(10_000)});
    if (!response.ok) throw new Error('HTTP failure');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid response');
    const code = (body as {code?: unknown; StatusCode?: unknown}).code ?? (body as {StatusCode?: unknown}).StatusCode;
    if (code !== 0) throw new Error('Provider rejected notification');
  } catch { throw new Error('Daemon webhook notification failed; see local health state (URL redacted)'); }
}
