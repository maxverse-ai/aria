import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatChatList, runChatList, runChatMention } from '../../../src/cli/commands/chat';
import {
  runConfigApply,
  runConfigConfirm,
} from '../../../src/cli/commands/config-change';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const listChats = vi.hoisted(() => vi.fn());

vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@larksuite/channel')>()),
  createLarkChannel: vi.fn(() => ({ listChats })),
}));

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  listChats.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('chat CLI handlers', () => {
  it('lists known chats with their mention-override state', async () => {
    const rootDir = await fixture({ chatRequireMention: { oc_team: false } });
    listChats.mockResolvedValue([
      { id: 'oc_team', name: 'Team' },
      { id: 'oc_other', name: '' },
    ]);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(String(line)));

    await runChatList({ rootDir, profile: 'primary', json: true });

    const snapshot = JSON.parse(output.pop()!);
    expect(snapshot).toMatchObject({
      schema: 'aria.chat.list.v1',
      profile: 'primary',
      requireMentionInGroup: true,
      chats: [
        { id: 'oc_team', name: 'Team', requireMention: false },
        { id: 'oc_other', requireMention: null },
      ],
    });
  });

  it('formats an empty chat list honestly', () => {
    const text = formatChatList({
      schema: 'aria.chat.list.v1',
      apiVersion: 1,
      profile: 'primary',
      requireMentionInGroup: true,
      chats: [],
    });
    expect(text).toContain('none visible');
  });

  it('emits a set-mention plan that config confirm+apply finishes', async () => {
    const rootDir = await fixture();
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(String(line)));

    await runChatMention('oc_team', 'on', { rootDir, profile: 'primary', json: true });
    const plan = JSON.parse(output.pop()!);
    expect(plan).toMatchObject({
      schema: 'aria.control.change-plan.v1',
      status: 'planned',
      operation: { id: 'profile.access.update', risk: 'sensitive' },
    });
    expect(output.pop()).toBeUndefined();

    // The same local-cli actor owns the plan, so the shared verbs finish it.
    await runConfigConfirm(plan.id, { rootDir, json: true });
    expect(JSON.parse(output.pop()!).status).toBe('confirmed');
    await runConfigApply(plan.id, { rootDir, json: true });
    expect(JSON.parse(output.pop()!)).toMatchObject({ schema: 'aria.control.change-apply.v1' });

    const root = await loadRootConfig(join(rootDir, 'config.json'));
    expect(root?.profiles.primary?.access.chatRequireMention).toEqual({ oc_team: true });
  });

  it('rejects values other than on|off', async () => {
    const rootDir = await fixture();
    await expect(
      runChatMention('oc_team', 'maybe', { rootDir, profile: 'primary' }),
    ).rejects.toThrow('expected on|off');
  });
});

async function fixture(access?: { chatRequireMention?: Record<string, boolean> }): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-chat-cli-'));
  roots.push(rootDir);
  const appPaths = resolveAppPaths({ rootDir, profile: 'primary' });
  // An env-template secret stays plaintext-shaped (no keystore migration)
  // and resolves without spawning the secrets-getter wrapper.
  process.env.ARIA_CHAT_TEST_SECRET = 'test-app-secret';
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: '${ARIA_CHAT_TEST_SECRET}', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  if (access?.chatRequireMention) {
    profile.access = { ...profile.access, chatRequireMention: access.chatRequireMention };
  }
  await saveRootConfig(createRootConfig('primary', profile), appPaths.configFile);
  await writeActiveProfile(rootDir, 'primary');
  return rootDir;
}
