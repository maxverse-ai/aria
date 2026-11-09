import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SUPERVISOR_CONTROL_PROFILE = '__aria_supervisor__';

export function admissionDirectory(profileDir: string): string { return join(profileDir, 'update-admission'); }
export async function createAdmissionMarker(profileDir: string): Promise<{ id: string; release(): Promise<void> }> {
  const directory = admissionDirectory(profileDir);
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const file = join(directory, `${id}.json`);
  // Publish complete records atomically; abandoned .pending files are not holds.
  const temporary = join(directory, `${id}.pending`);
  await writeFile(temporary, JSON.stringify({ id, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  try { await link(temporary, file); } finally { await rm(temporary, { force: true }); }
  return { id, release: () => rm(file, { force: true }) };
}
export async function activeAdmissionMarkers(profileDir: string): Promise<string[]> {
  const directory = admissionDirectory(profileDir);
  let files: string[];
  try { files = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const active: string[] = [];
  for (const name of files.filter(name => name.endsWith('.json'))) {
    try {
      const value = JSON.parse(await readFile(join(directory, name), 'utf8')) as { id: string; pid: number };
      if (value.id !== name.slice(0, -5) || !Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error('invalid admission marker');
      try { process.kill(value.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
      }
      active.push(value.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') active.push(name.slice(0, -5));
    }
  }
  return active;
}

export class UpdateAdmissionFence {
  private resume?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private refreshTail: Promise<unknown> = Promise.resolve();
  constructor(private readonly profileDir: string, private readonly pause: () => () => void) {}
  refresh(): Promise<string[]> {
    const result = this.refreshTail.then(() => this.refreshNow());
    this.refreshTail = result.catch(() => undefined);
    return result;
  }
  private async refreshNow(): Promise<string[]> {
    const markers = await activeAdmissionMarkers(this.profileDir);
    if (this.closed) return [];
    if (markers.length) this.resume ??= this.pause();
    else { this.resume?.(); this.resume = undefined; }
    return markers;
  }
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh().catch(() => { if (!this.closed) this.resume ??= this.pause(); }); }, 250);
    this.timer.unref();
  }
  close(): void { this.closed = true; clearInterval(this.timer); this.resume?.(); this.resume = undefined; }
}
