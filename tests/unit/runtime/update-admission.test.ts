import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateAdmissionFence, createAdmissionMarker, activeAdmissionMarkers, admissionDirectory } from '../../../src/runtime/update-admission';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'aria-admission-')); directories.push(path); return path; }
describe('update admission generation ownership', () => {
  it('fences startup and keeps successor hold after prior owner releases', async () => {
    const path = await directory();
    const first = await createAdmissionMarker(path);
    let paused = 0;
    const pause = vi.fn(() => { paused++; return () => { paused--; }; });
    const fence = new UpdateAdmissionFence(path, pause);
    await fence.start();
    try {
      expect(paused).toBe(1);
      const successor = await createAdmissionMarker(path);
      await first.release();
      await fence.refresh();
      expect(paused).toBe(1);
      expect(await activeAdmissionMarkers(path)).toEqual([successor.id]);
      await first.release();
      await successor.release();
      await fence.refresh();
      expect(paused).toBe(0);
      expect(pause).toHaveBeenCalledOnce();
    } finally { fence.close(); }
  });
  it('rejects a late drain after release and always releases its execution pause', async () => {
    const path = await directory();
    const marker = await createAdmissionMarker(path);
    let executionPauses = 0;
    let finishDrain!: () => void;
    const drainBarrier = new Promise<void>(resolve => { finishDrain = resolve; });
    const fence = new UpdateAdmissionFence(path, () => () => {});
    await fence.start();
    const pause = () => { executionPauses++; return () => { executionPauses--; }; };
    try {
      const lateDrain = (async () => { await drainBarrier; await fence.pauseExecution(marker.id, pause); })();
      await marker.release();
      await fence.refresh();
      finishDrain();
      await expect(lateDrain).rejects.toThrow('owner disappeared');
      expect(executionPauses).toBe(0);
      const next = await createAdmissionMarker(path);
      await fence.pauseExecution(next.id, pause);
      expect(executionPauses).toBe(1);
      await next.release(); await fence.refresh();
      expect(executionPauses).toBe(0);
    } finally { fence.close(); }
  });

  it('automatically ignores only confirmed-dead owners and fails closed on uncertain files', async () => {
    const path = await directory();
    await mkdir(admissionDirectory(path), { recursive: true });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    try {
      await writeFile(join(admissionDirectory(path), 'dead.json'), JSON.stringify({ id: 'dead', pid: 1234 }));
      expect(await activeAdmissionMarkers(path)).toEqual([]);
      kill.mockImplementation(() => { throw Object.assign(new Error('unknown'), { code: 'EPERM' }); });
      expect(await activeAdmissionMarkers(path)).toEqual(['dead']);
      await writeFile(join(admissionDirectory(path), 'partial.pending'), '');
      await writeFile(join(admissionDirectory(path), 'invalid.json'), '');
      expect(await activeAdmissionMarkers(path)).toEqual(['dead', 'invalid']);
    } finally { kill.mockRestore(); }
  });
});
