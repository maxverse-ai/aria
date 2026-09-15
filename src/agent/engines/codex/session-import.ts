import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { assertConfinedPath } from '../../../platform/confined-path';
import { writeFileAtomic } from '../../../platform/atomic-write';
import { startCodexAppServer } from './app-server/process';
import type { NativeSessionImportInput, NativeSessionImportReceipt } from '../../runtime/session-import';

/** Codex owns rollout import and its database repair. Aria never edits native
 * SQLite tables or imports shared auth, memory, shell snapshots or logs. */
export async function importCodexSessions(input: NativeSessionImportInput): Promise<NativeSessionImportReceipt> {
  const nativeHome = join(input.home, '.codex');
  const directory = join(nativeHome, 'sessions');
  await assertConfinedPath(input.home, directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (new Set(input.sources.map((source) => source.nativeId)).size !== input.sources.length) throw new Error('duplicate native import id');
  const files = new Map<string, string>();
  for (const source of input.sources) {
    if (!/^[a-f0-9-]{36}$/.test(source.nativeId) || !/^[a-f0-9]{64}$/.test(source.sha256)
      || !basename(source.sourceFile).startsWith('rollout-')
      || !basename(source.sourceFile).endsWith(source.nativeId + '.jsonl')) throw new Error('invalid Codex rollout source');
    await assertConfinedPath('/', source.sourceFile);
    const date = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(basename(source.sourceFile));
    if (!date) throw new Error('native rollout date is missing');
    const partition = await assertConfinedPath(directory, join(directory, date[1]!, date[2]!, date[3]!));
    await mkdir(partition, { recursive: true, mode: 0o700 });
    const target = await assertConfinedPath(directory, join(partition, basename(source.sourceFile)));
    await copyVerified(source.sourceFile, target, source.sha256, source.nativeId);
    files.set(source.nativeId, target);
  }
  const client = await input.withLaunch(() => startCodexAppServer({ binary: input.binary, cwd: input.workspace,
    codexHome: nativeHome, inheritCodexHome: false, profileStateDir: input.stateDirectory }));
  try {
    for (const [id, path] of files) {
      const resumed = await client.request<{ thread: { id: string }; cwd: string }>('thread/resume', {
        threadId: id, path, cwd: input.workspace, approvalPolicy: 'never',
        sandbox: input.profile.sandbox.defaultMode, excludeTurns: true,
      }, 30_000);
      if (resumed.thread?.id !== id || resumed.cwd !== input.workspace) throw new Error('native imported thread ownership mismatch');
      const read = await client.request<{ thread: { id: string } }>('thread/read', { threadId: id, includeTurns: false });
      if (read.thread?.id !== id) throw new Error('native imported thread cannot be read');
    }
    // The native thread's recorded cwd describes its history, while resume.cwd
    // governs future turns. Repair via Codex and keep an explicit query alias;
    // never rewrite historical messages or SQLite rows to make these equal.
    const found = new Map<string, string>();
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.request<{ data: { id: string; cwd: string }[]; nextCursor?: string | null }>('thread/list', {
        limit: 100, useStateDbOnly: false, modelProviders: [],
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page.data)) throw new Error('invalid native history after import');
      for (const thread of page.data) if (files.has(thread.id) && typeof thread.cwd === 'string') found.set(thread.id, thread.cwd);
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error('native history import cursor repeated');
      if (cursor) seen.add(cursor);
      if (seen.size > 1000) throw new Error('native imported history exceeded its bound');
    } while (cursor);
    if ([...files.keys()].some((id) => !found.has(id))) throw new Error('imported thread is absent from the native history index');
    await writeFileAtomic(join(input.stateDirectory, 'codex-session-imports.v1.json'), JSON.stringify({
      schema: 'aria.codex-session-imports.v1',
      entries: [...found].map(([nativeId, nativeCwd]) => ({ nativeId, nativeCwd, workspace: input.workspace })),
    }) + '\n', { mode: 0o600 });
    return { schema: 'aria.native-session-import.v1', engineId: 'codex',
      nativeIds: [...files.keys()], verification: 'native-resume-read-list' };
  } finally {
    await client.dispose();
    // Codex creates process-local executable aliases below tmp/arg0 when its
    // home is outside /tmp (including ***REMOVED***'s /data). They are not imported
    // history. After this sole staging process exits, remove its scratch tree
    // before the management owner seals the destination. Keep the general
    // destination symlink rejection and every persistent native file intact.
    const scratch = await assertConfinedPath(nativeHome, join(nativeHome, 'tmp'));
    await rm(scratch, { recursive: true, force: true });
  }
}

async function copyVerified(source: string, target: string, expected: string, nativeId: string): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size > 2 * 1024 ** 3) throw new Error('invalid native rollout file');
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(256 * 1024);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset);
          if (!bytesWritten) throw new Error('native rollout copy did not advance');
          offset += bytesWritten;
        }
      }
      await output.sync();
      const after = await input.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || hash.digest('hex') !== expected) throw new Error('native source changed during migration');
    } finally { await output.close(); }
  } finally { await input.close(); }
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.allocUnsafe(1024 * 1024);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const end = header.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw new Error('missing native session metadata');
    const first = JSON.parse(header.subarray(0, end).toString('utf8'));
    if (first.type !== 'session_meta' || first.payload?.id !== nativeId) throw new Error('native rollout id mismatch');
  } finally { await file.close(); }
}
