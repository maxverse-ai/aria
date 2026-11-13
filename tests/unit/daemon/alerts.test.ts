import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
vi.mock('../../../src/platform/spawn', () => ({spawnProcessSync: vi.fn(() => ({status: 0}))}));
import {sendDaemonAlert} from '../../../src/daemon/alerts';
const dirs: string[] = [];
afterEach(async () => {vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive: true, force: true})));});
async function fixture(webhookUrl?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'aria-daemon-alert-')); dirs.push(dir);
  if (webhookUrl) await writeFile(join(dir, 'alerts.json'), JSON.stringify({webhookUrl}));
  return dir;
}
describe('daemon alert delivery', () => {
  it('records locally without an opted-in network destination and redacts credentials', async () => {
    const dir = await fixture(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await sendDaemonAlert(dir, 'app_secret=private-value C:\\private\\project');
    const log = await readFile(join(dir, 'alerts.jsonl'), 'utf8');
    expect(log).not.toContain('private-value'); expect(log).not.toContain('C:\\private');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('validates HTTPS, rejects provider failures and never leaks webhook credentials', async () => {
    const insecure = await fixture('http://example.test/private');
    await expect(sendDaemonAlert(insecure, 'test')).rejects.toThrow('HTTPS');
    const dir = await fixture('https://example.test/private-secret');
    const fetch = vi.fn().mockResolvedValue({ok: true, json: async () => ({code: 1, msg: 'private-secret'})}); vi.stubGlobal('fetch', fetch);
    await expect(sendDaemonAlert(dir, 'test')).rejects.toThrow('URL redacted');
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({redirect: 'error'}));
    fetch.mockResolvedValue({ok: true, json: async () => ({StatusCode: 0})});
    await expect(sendDaemonAlert(dir, 'recovered')).resolves.toBeUndefined();
  });
});
