import { afterEach, expect, it, vi } from 'vitest';
import { startProfileOnHost } from '../../../src/cli/profile-online';
const mocks = vi.hoisted(() => ({ read: vi.fn(), alive: vi.fn(() => true) }));
vi.mock('../../../src/ui/sidecar', () => ({ readUiSidecar: mocks.read }));
vi.mock('../../../src/runtime/registry', () => ({ isAlive: mocks.alive }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const sidecar = { url: 'http://127.0.0.1:1234/?token=private-token', token: 'private-token', pid: 123 };
it('uses the existing authenticated host without putting credentials in the request URL', async () => {
  mocks.read.mockResolvedValue(sidecar);
  const fetch = vi.fn(async (_url: URL, _options: RequestInit) => new Response(JSON.stringify({ ok: true, profile: 'Alice' })));
  vi.stubGlobal('fetch', fetch);
  await startProfileOnHost('Alice', '/tmp/test-root');
  expect(String(fetch.mock.calls[0]![0])).toBe('http://127.0.0.1:1234/api/profiles/start');
  expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
    method: 'POST', redirect: 'error', body: '{"profile":"Alice"}',
    headers: expect.objectContaining({ 'x-ui-token': 'private-token' }),
  }));
});
it('reports missing host without creating a second service', async () => {
  mocks.read.mockResolvedValue(undefined);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(startProfileOnHost('Alice')).rejects.toThrow('aria start --web-ui');
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects a non-local sidecar before sending its token', async () => {
  mocks.read.mockResolvedValue({ ...sidecar, url: 'https://example.com/' });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(startProfileOnHost('Alice')).rejects.toThrow('本机');
  expect(fetch).not.toHaveBeenCalled();
});
it('propagates startup failures, and does not claim success on timeout', async () => {
  mocks.read.mockResolvedValue(sidecar);
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'engine unavailable' }), { status: 400 }))
    .mockRejectedValueOnce(new Error('connection failed private-token'));
  vi.stubGlobal('fetch', fetch);
  await expect(startProfileOnHost('Alice')).rejects.toThrow('engine unavailable');
  await expect(startProfileOnHost('Alice')).rejects.toThrow('无法确认');
});
