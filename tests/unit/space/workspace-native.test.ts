import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCodexAppServer } from '../../../src/agent/engines/codex/app-server/process';
import { verifyWorkspaceSkillCatalog } from '../../../src/agent/runtime/workspace-assets';
vi.mock('../../../src/agent/engines/codex/app-server/process', () => ({ startCodexAppServer: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const input = { engineId: 'codex', binary: '/bin/codex', cwd: '/space/workspace', home: '/space/home', state: '/space/state', skills: ['review'] };
describe('workspace native discovery', () => {
  it('checks the actual enabled native skill path, reloads metadata and never creates a thread', async () => {
    const client = { request: vi.fn(async () => ({ data: [{ cwd: input.cwd, errors: [], skills: [{ name: 'review', enabled: true, path: '/space/home/.codex/skills/review/SKILL.md' }] }] })), dispose: vi.fn(async () => {}) };
    vi.mocked(startCodexAppServer).mockResolvedValue(client as never);
    await verifyWorkspaceSkillCatalog(input);
    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith('skills/list', { cwds: [input.cwd], forceReload: true }, 10_000, undefined);
    expect(client.dispose).toHaveBeenCalledOnce();
  });
  it.each([
    { enabled: false, path: '/space/home/.codex/skills/review/SKILL.md' },
    { enabled: true, path: '/old/home/.codex/skills/review/SKILL.md' },
  ])('does not certify a disabled or shadowed skill', async skill => {
    const client = { request: vi.fn(async () => ({ data: [{ cwd: input.cwd, errors: [], skills: [{ name: 'review', ...skill }] }] })), dispose: vi.fn(async () => {}) };
    vi.mocked(startCodexAppServer).mockResolvedValue(client as never);
    await expect(verifyWorkspaceSkillCatalog(input)).rejects.toThrow('not discovered'); expect(client.dispose).toHaveBeenCalledOnce();
  });
  it('retains explicit catalog delivery for other engines and closes a failed probe', async () => {
    await verifyWorkspaceSkillCatalog({ ...input, engineId: 'claude' }); expect(startCodexAppServer).not.toHaveBeenCalled();
    const client = { request: vi.fn().mockRejectedValue(new Error('failed')), dispose: vi.fn(async () => {}) };
    vi.mocked(startCodexAppServer).mockResolvedValue(client as never);
    await expect(verifyWorkspaceSkillCatalog(input)).rejects.toThrow('failed'); expect(client.dispose).toHaveBeenCalledOnce();
  });
});
