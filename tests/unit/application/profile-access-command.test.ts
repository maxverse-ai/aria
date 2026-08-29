import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigChangeService,
  PROFILE_ACCESS_UPDATE_COMMAND,
  authorizeAdapterCommands,
  managementCommandRegistry,
  profileAccessUpdateCommand,
  profileAccessUpdateParameters,
} from '../../../src/application/control';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile access management command', () => {
  it('updates access through a deterministic identifier-private contract', () => {
    const root = fixtureRoot();
    const parameters = profileAccessUpdateParameters({
      action: 'add',
      kind: 'user',
      targets: ['ou_private_alice', 'ou_private_alice'],
      requireMention: null,
    });
    const first = profileAccessUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters,
    });
    const replay = profileAccessUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters,
    });

    expect(first).toEqual(replay);
    expect(profileAccessUpdateCommand).toMatchObject({
      id: PROFILE_ACCESS_UPDATE_COMMAND,
      risk: 'sensitive',
      effect: 'live',
      parameterPrivacy: 'private-identifiers',
    });
    expect(first.root.profiles.primary?.access.allowedUsers).toEqual(['ou_private_alice']);
    expect(first.changes).toEqual([
      { field: 'access.allowedUsers.count', before: 0, after: 1 },
    ]);
    expect(JSON.stringify(first.changes)).not.toContain('ou_private_alice');
    expect(first.root.profiles.secondary).toEqual(root.profiles.secondary);
  });

  it('sets redacted chat overrides and removes them with the chat', () => {
    const root = fixtureRoot();
    root.profiles.primary!.access.allowedChats = ['oc_private_group'];

    const set = profileAccessUpdateCommand.prepare({
      root: structuredClone(root),
      profile: 'primary',
      parameters: profileAccessUpdateParameters({
        action: 'set-mention',
        kind: 'chat',
        targets: ['oc_private_group'],
        requireMention: false,
      }),
    });
    expect(set.root.profiles.primary?.access.chatRequireMention).toEqual({
      oc_private_group: false,
    });
    expect(set.changes).toEqual([
      { field: 'access.chatMentionOverrides.count', before: 0, after: 1 },
      { field: 'access.chatMentionOverride.value', before: null, after: false },
    ]);

    const removed = profileAccessUpdateCommand.prepare({
      root: set.root,
      profile: 'primary',
      parameters: profileAccessUpdateParameters({
        action: 'remove',
        kind: 'chat',
        targets: ['oc_private_group'],
        requireMention: null,
      }),
    });
    expect(removed.root.profiles.primary?.access.allowedChats).toEqual([]);
    expect(removed.root.profiles.primary?.access.chatRequireMention).toBeUndefined();
    expect(JSON.stringify(removed.changes)).not.toContain('oc_private_group');
  });

  it('requires explicit source-scoped authorization and keeps identifiers out of public plans', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'aria-access-command-'));
    roots.push(rootDir);
    const paths = resolveAppPaths({ rootDir, profile: 'primary' });
    await saveRootConfig(fixtureRoot(), paths.configFile);
    await writeActiveProfile(rootDir, 'primary');
    const actor = { source: 'web' as const, principal: 'local-console' };
    const request = {
      operationId: PROFILE_ACCESS_UPDATE_COMMAND,
      profile: 'primary',
      parameters: profileAccessUpdateParameters({
        action: 'add' as const,
        kind: 'admin' as const,
        targets: ['ou_private_admin'],
        requireMention: null,
      }),
      actor,
    };

    await expect(new ConfigChangeService({
      rootDir,
      registry: managementCommandRegistry,
    }).createPlan(request)).rejects.toMatchObject({ code: 'operation-unavailable' });

    const service = new ConfigChangeService({
      rootDir,
      registry: managementCommandRegistry,
      authorizeCommand: authorizeAdapterCommands('web', [PROFILE_ACCESS_UPDATE_COMMAND]),
      createId: () => '0123456789abcdef0123456789abcdef',
    });
    const plan = await service.createPlan(request);
    expect(plan.operation).toMatchObject({ id: PROFILE_ACCESS_UPDATE_COMMAND, risk: 'sensitive' });
    expect(JSON.stringify(plan)).not.toContain('ou_private_admin');
    await service.confirmPlan(plan.id, actor);
    await service.commitPlan(plan.id, actor);
    expect((await loadRootConfig(paths.configFile))?.profiles.primary?.access.admins).toEqual([
      'ou_private_admin',
    ]);
    const stored = await readFile(join(rootDir, 'control', 'plans', `${plan.id}.json`), 'utf8');
    expect(stored).toContain('ou_private_admin');
    expect(stored).not.toContain('local-console');
  });
});

function fixtureRoot() {
  const primary = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_primary', secret: 'super-secret', tenant: 'feishu' } },
  });
  const root = createRootConfig('primary', primary);
  root.profiles.secondary = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_secondary', secret: 'other-secret', tenant: 'lark' } },
  });
  return root;
}
