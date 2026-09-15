import { spawn } from 'node:child_process';
import { mkdir, readFile, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';

export interface ExecutionOwnerRecord {
  schema: 'aria.execution-owner.v1';
  key: string;
  generation: string;
}
export interface ExecutionOwnershipLease {
  readonly healthy: boolean;
  read(): Promise<ExecutionOwnerRecord | undefined>;
  write(record: ExecutionOwnerRecord): Promise<void>;
  release(): Promise<void>;
}
export interface ExecutionOwnership {
  acquire(key: string): Promise<ExecutionOwnershipLease>;
}

/** Linux kernel lock held by a pipe-bound helper, not a renewable time lease.
 * The trusted manager directory must never be mounted into an agent runtime.
 */
export class FileExecutionOwnership implements ExecutionOwnership {
  constructor(private readonly directory: string) {}
  async acquire(key: string): Promise<ExecutionOwnershipLease> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid execution ownership key');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
      throw new Error('execution ownership directory must be private');
    }
    const path = join(this.directory, key);
    const file = await open(path + '.lock', constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const child = spawn('/usr/bin/flock', ['--nonblock', '--exclusive', '/proc/self/fd/3', process.execPath, '-e',
      "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.once('end',()=>process.exit(0))"], {
      stdio: ['pipe', 'pipe', 'ignore', file.fd], env: { PATH: '/usr/bin:/bin' },
    });
    let healthy = false;
    let released = false;
    const ended = new Promise<void>((resolve) => child.once('close', () => { healthy = false; resolve(); }));
    try {
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('execution lock startup timed out')); }, 5000);
        child.once('error', () => { clearTimeout(timer); reject(new Error('execution lock helper unavailable')); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('execution environment is owned by another manager')); });
        child.stdout!.once('data', (value: Buffer) => {
          clearTimeout(timer);
          if (value.toString() !== 'ready\n') { child.kill('SIGKILL'); reject(new Error('invalid execution lock response')); }
          else { healthy = true; resolve(); }
        });
      });
      // Install error listeners before the first await after spawning.
      await Promise.all([ready, file.close()]);
    } catch (error) { child.stdin!.end(); await ended; throw error; }
    const assertHeld = () => { if (!healthy || released) throw new Error('execution ownership was lost'); };
    return {
      get healthy() { return healthy && !released; },
      async read() {
        assertHeld();
        let value: unknown;
        try { value = JSON.parse(await readFile(path + '.json', 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
        const record = value as ExecutionOwnerRecord;
        if (record?.schema !== 'aria.execution-owner.v1' || record.key !== key
          || !/^[a-f0-9-]{36}$/.test(record.generation)) throw new Error('invalid execution ownership record');
        assertHeld(); return record;
      },
      async write(record) {
        assertHeld();
        if (record.key !== key) throw new Error('execution ownership key differs');
        await writeFileAtomic(path + '.json', JSON.stringify(record) + '\n', { mode: 0o600 });
        assertHeld();
      },
      async release() {
        if (released) { await ended; return; }
        released = true; child.stdin!.end(); await ended;
      },
    };
  }
}
