import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAuditRecorder } from '../../../src/application/control/native-audit-recorder';
import { FileNativeReadRepository } from '../../../src/platform/file-native-read-repository';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('NativeAuditRecorder', () => {
  it('records explicit structured evidence and makes retries idempotent', async () => {
    const { recorder, repository } = await setup();
    const input = {
      eventId: 'native-operation-secret', action: 'run.completed' as const,
      actor: { kind: 'system' as const }, outcome: 'success' as const, redacted: true,
      runId: 'run_opaque', latencyMs: 42,
    };
    const first = await recorder.record(input);
    const second = await recorder.record(input);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ action: 'run.completed', outcome: 'success', latencyMs: 42, revision: 1 });
    expect(await repository.list('audit-event')).toHaveLength(1);
    expect((await repository.changes(null)).changes).toHaveLength(1);
  });

  it('does not persist the source operation ID or unrestricted metadata', async () => {
    const { recorder, journalFile } = await setup();
    await recorder.record({
      eventId: 'credential-token-shaped-source-id', action: 'credential.accessed',
      actor: { kind: 'local-cli' }, target: { resourceType: 'credential' },
      outcome: 'denied', errorCode: 'POLICY_DENIED', redacted: true,
    });
    const journal = await readFile(journalFile, 'utf8');
    expect(journal).not.toContain('credential-token-shaped-source-id');
    expect(journal).toContain('POLICY_DENIED');
  });

  it('rejects invalid latency and success records carrying an error code', async () => {
    const { recorder } = await setup();
    await expect(recorder.record({
      eventId: 'event-1', action: 'run.completed', actor: { kind: 'system' },
      outcome: 'success', errorCode: 'NOT_AN_ERROR', redacted: true,
    })).rejects.toThrow('errorCode');
    await expect(recorder.record({
      eventId: 'event-2', action: 'run.failed', actor: { kind: 'system' },
      outcome: 'failure', latencyMs: -1, redacted: true,
    })).rejects.toThrow('latencyMs');
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'aria-audit-'));
  roots.push(root);
  const journalFile = join(root, 'changes.jsonl');
  const repository = new FileNativeReadRepository({
    profileId: 'demo', snapshotFile: join(root, 'snapshot.json'), journalFile,
  });
  const recorder = new NativeAuditRecorder({
    profileId: 'demo', repository, now: () => '2026-08-27T00:00:00.000Z',
  });
  return { recorder, repository, journalFile };
}
