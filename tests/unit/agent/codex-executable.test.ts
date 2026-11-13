import {mkdtemp, mkdir, writeFile, rm, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {resolveCodexExecutable} from '../../../src/agent/engines/codex/executable';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true}))); });
async function fixture() {
  const localAppData = await mkdtemp(join(tmpdir(), 'aria-codex-discovery-')); directories.push(localAppData);
  const root = join(localAppData, 'OpenAI', 'Codex', 'bin'); await mkdir(root, {recursive: true});
  return {localAppData, root};
}
describe('Codex executable discovery', () => {
  it('recovers an obsolete desktop path within the same canonical installation', async () => {
    const {localAppData, root} = await fixture();
    const replacement = join(root, '2222222222222222', 'codex.exe');
    await mkdir(join(root, '2222222222222222')); await writeFile(replacement, '', {mode: 0o700});
    const resolveCommand = vi.fn().mockRejectedValue(Object.assign(Error('missing'), {code: 'ENOENT'}));
    expect(await resolveCodexExecutable(join(root, '1111111111111111', 'codex.exe'), {platform: 'win32', localAppData, resolveCommand, probe: async () => true})).toBe(replacement);
  });
  it('does not switch an explicit independent binary to the desktop install', async () => {
    const {localAppData, root} = await fixture();
    const resolveCommand = vi.fn().mockRejectedValue(Error('pinned missing'));
    await expect(resolveCodexExecutable(join(root, '..', '..', '..', 'independent', 'codex.exe'), {platform: 'win32', localAppData, resolveCommand})).rejects.toThrow('pinned missing');
  });
  it('does not bypass permission failures for a configured desktop executable', async () => {
    const {localAppData, root} = await fixture();
    await expect(resolveCodexExecutable(join(root, '1111111111111111', 'codex.exe'), {
      platform: 'win32', localAppData, resolveCommand: vi.fn().mockRejectedValue(Object.assign(Error('denied'), {code: 'EACCES'})),
    })).rejects.toThrow('denied');
  });
  it('rediscovers after an update without caching a retired version', async () => {
    const {localAppData, root} = await fixture();
    const options = {platform: 'win32' as const, localAppData, resolveCommand: vi.fn().mockRejectedValue(Error('stale PATH')), probe: async () => true};
    const first = join(root, '1111111111111111', 'codex.exe'); await mkdir(join(root, '1111111111111111')); await writeFile(first, '', {mode: 0o700});
    await utimes(first, 1, 1);
    expect(await resolveCodexExecutable('codex', options)).toBe(first);
    const second = join(root, '2222222222222222', 'codex.exe'); await mkdir(join(root, '2222222222222222')); await writeFile(second, '', {mode: 0o700});
    expect(await resolveCodexExecutable('codex', options)).toBe(second);
    const rejectNew = vi.fn(async (binary: string) => binary !== second);
    expect(await resolveCodexExecutable('codex', {...options, probe: rejectNew})).toBe(first);
    expect(rejectNew).toHaveBeenCalledTimes(2);
    await expect(resolveCodexExecutable('codex', {...options, platform: 'linux'})).rejects.toThrow('stale PATH');
  });
});
