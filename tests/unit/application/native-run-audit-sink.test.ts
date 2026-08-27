import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAuditRecorder } from '../../../src/application/control/native-audit-recorder';
import { NativeRunAuditSink } from '../../../src/application/control/native-run-audit-sink';
import type { NativeAuditEventResource, NativeRunResource } from '../../../src/application/control/native-read-types';
import { FileNativeReadRepository } from '../../../src/platform/file-native-read-repository';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('NativeRunAuditSink', () => {
  it('persists opaque run references and never persists the executor run ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-run-audit-'));
    roots.push(root);
    const journalFile = join(root, 'changes.jsonl');
    const repository = new FileNativeReadRepository({
      profileId: '***REMOVED***', snapshotFile: join(root, 'snapshot.json'), journalFile,
    });
    const sink = new NativeRunAuditSink({
      profileId: '***REMOVED***', recorder: new NativeAuditRecorder({ profileId: '***REMOVED***', repository }), repository,
    });

    await sink.record({
      eventId: 'source-run-secret:started', sourceRunId: 'source-run-secret',
      action: 'run.started', occurredAt: '2026-08-27T00:00:00.000Z', outcome: 'success',
    });

    const [event] = await repository.list<NativeAuditEventResource>('audit-event');
    expect(event?.runId).toMatch(/^run_/);
    expect(event?.runId).not.toBe('source-run-secret');
    expect(await repository.list<NativeRunResource>('run')).toEqual([
      expect.objectContaining({ id: event?.runId, status: 'running', associationStatus: 'pending' }),
    ]);
    expect(await readFile(journalFile, 'utf8')).not.toContain('source-run-secret');
  });

  it('records tool evidence without mutating the run lifecycle resource', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-tool-audit-'));
    roots.push(root);
    const journalFile = join(root, 'changes.jsonl');
    const repository = new FileNativeReadRepository({
      profileId: '***REMOVED***', snapshotFile: join(root, 'snapshot.json'), journalFile,
    });
    const sink = new NativeRunAuditSink({
      profileId: '***REMOVED***', recorder: new NativeAuditRecorder({ profileId: '***REMOVED***', repository }), repository,
    });

    await sink.record({
      eventId: 'source-run-secret:started', sourceRunId: 'source-run-secret',
      action: 'run.started', occurredAt: '2026-08-27T00:00:00.000Z', outcome: 'success',
    });
    await sink.record({
      eventId: 'source-run-secret:tool:private-tool-id:completed', sourceRunId: 'source-run-secret',
      action: 'tool.completed', occurredAt: '2026-08-27T00:00:01.000Z', outcome: 'failure',
      errorCode: 'TOOL_ERROR', latencyMs: 1000,
    });

    const events = await repository.list<NativeAuditEventResource>('audit-event');
    const started = events.find((event) => event.action === 'run.started');
    const completed = events.find((event) => event.action === 'tool.completed');
    expect(events.map((event) => event.action).sort()).toEqual(['run.started', 'tool.completed']);
    expect(completed).toMatchObject({
      runId: started?.runId, outcome: 'failure', errorCode: 'TOOL_ERROR', latencyMs: 1000,
    });
    expect(await repository.list<NativeRunResource>('run')).toEqual([
      expect.objectContaining({ status: 'running', updatedAt: '2026-08-27T00:00:00.000Z' }),
    ]);
    expect(await readFile(journalFile, 'utf8')).not.toContain('private-tool-id');
  });
});
