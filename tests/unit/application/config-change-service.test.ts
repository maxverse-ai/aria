import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigChangeService,
  type ManagementCommandDefinition,
  type ControlActorContext,
} from '../../../src/application/control';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const roots: string[] = [];
const actor: ControlActorContext = { source: 'agent', principal: 'ou_private_actor' };
const planId = '0123456789abcdef0123456789abcdef';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ConfigChangeService', () => {
  it('persists a redacted plan and only writes configuration after confirm + apply', async () => {
    const fixture = await createFixture();
    const service = createService(fixture.root);

    const plan = await service.createPlan({
      operationId: operation.id,
      parameters: { value: false },
      actor,
    });
    const beforeApply = await loadRootConfig(fixture.configPath);

    expect(plan).toMatchObject({
      schema: 'aria.control.change-plan.v1',
      id: planId,
      profile: 'primary',
      resource: { kind: 'profile', profile: 'primary' },
      status: 'planned',
      operation: { id: operation.id, risk: 'low' },
      changes: [{ field: 'access.requireMentionInGroup', before: true, after: false }],
    });
    expect(plan.baseRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.targetRevision).not.toBe(plan.baseRevision);
    expect(JSON.stringify(plan)).not.toContain('ou_private_actor');
    expect(JSON.stringify(plan)).not.toContain('super-secret');
    expect(JSON.stringify(plan)).not.toContain('parameters');
    expect(JSON.stringify(plan)).not.toContain('runtimeEffect');
    expect(beforeApply?.profiles.primary?.access.requireMentionInGroup).toBe(true);

    const confirmed = await service.confirmPlan(plan.id, actor);
    expect(confirmed.status).toBe('confirmed');
    const commit = await service.commitPlan(plan.id, actor);
    const result = commit.applyResult;
    const afterApply = await loadRootConfig(fixture.configPath);

    expect(commit.effect).toBe('restart');
    expect(result).toMatchObject({
      schema: 'aria.control.change-apply.v1',
      planId,
      resultRevision: plan.targetRevision,
      recovered: false,
    });
    expect(afterApply?.profiles.primary?.access.requireMentionInGroup).toBe(false);
    expect((await service.getPlan(plan.id)).status).toBe('applied');

    const storedPlan = await readFile(join(fixture.root, 'control', 'plans', `${planId}.json`), 'utf8');
    expect(storedPlan).not.toContain('ou_private_actor');
    expect(storedPlan).not.toContain('super-secret');
    expect(storedPlan).toContain('"runtimeEffect": "restart"');
  });

  it('requires explicit confirmation by the same actor', async () => {
    const fixture = await createFixture();
    const service = createService(fixture.root);
    const plan = await service.createPlan({
      operationId: operation.id,
      parameters: { value: false },
      actor,
    });

    await expect(service.applyPlan(plan.id, actor)).rejects.toMatchObject({
      code: 'not-confirmed',
    });
    await expect(
      service.confirmPlan(plan.id, { source: 'agent', principal: 'ou_someone_else' }),
    ).rejects.toMatchObject({ code: 'actor-mismatch' });
  });

  it('rejects a stale plan instead of overwriting a concurrent configuration change', async () => {
    const fixture = await createFixture();
    const service = createService(fixture.root);
    const plan = await service.createPlan({
      operationId: operation.id,
      parameters: { value: false },
      actor,
    });
    await service.confirmPlan(plan.id, actor);

    const concurrent = await loadRootConfig(fixture.configPath);
    concurrent!.profiles.primary!.preferences.model = 'changed-concurrently';
    await saveRootConfig(concurrent!, fixture.configPath);

    await expect(service.applyPlan(plan.id, actor)).rejects.toMatchObject({
      code: 'revision-conflict',
    });
    const after = await loadRootConfig(fixture.configPath);
    expect(after?.profiles.primary?.access.requireMentionInGroup).toBe(true);
    expect(after?.profiles.primary?.preferences.model).toBe('changed-concurrently');
  });

  it('expires unconfirmed plans and rejects operations that touch another profile', async () => {
    const fixture = await createFixture(true);
    let now = new Date('2026-01-01T00:00:00.000Z');
    const service = new ConfigChangeService({
      rootDir: fixture.root,
      operations: [operation],
      createId: () => planId,
      planTtlMs: 1_000,
      now: () => now,
    });
    const plan = await service.createPlan({ operationId: operation.id, parameters: { value: false }, actor });
    now = new Date('2026-01-01T00:00:01.000Z');
    await expect(service.confirmPlan(plan.id, actor)).rejects.toMatchObject({
      code: 'expired',
    });

    const invalid = new ConfigChangeService({
      rootDir: fixture.root,
      operations: [crossProfileOperation],
      createId: () => 'fedcba9876543210fedcba9876543210',
    });
    await expect(
      invalid.createPlan({ operationId: crossProfileOperation.id, actor }),
    ).rejects.toMatchObject({ code: 'invalid-plan' });
  });

  it('rejects operation payloads that would persist known sensitive values', async () => {
    const fixture = await createFixture();
    const service = new ConfigChangeService({
      rootDir: fixture.root,
      operations: [leakingOperation],
      createId: () => planId,
    });

    await expect(
      service.createPlan({ operationId: leakingOperation.id, actor }),
    ).rejects.toMatchObject({ code: 'invalid-plan' });
  });

  it('fails closed for sensitive operations until a stronger policy is installed', async () => {
    const fixture = await createFixture();
    const service = new ConfigChangeService({
      rootDir: fixture.root,
      operations: [{ ...operation, id: 'test.sensitive', risk: 'sensitive' }],
      createId: () => planId,
    });

    await expect(
      service.createPlan({ operationId: 'test.sensitive', parameters: { value: false }, actor }),
    ).rejects.toMatchObject({ code: 'operation-unavailable' });
  });
});

const operation: ManagementCommandDefinition = {
  id: 'test.access.require-mention',
  version: 1,
  risk: 'low',
  effect: 'restart',
  prepare({ root, profile, parameters }) {
    if (typeof parameters.value !== 'boolean') throw new Error('value must be boolean');
    const current = root.profiles[profile]!;
    const before = current.access.requireMentionInGroup;
    root.profiles[profile] = {
      ...current,
      access: { ...current.access, requireMentionInGroup: parameters.value },
    };
    return {
      root,
      changes: [{ field: 'access.requireMentionInGroup', before, after: parameters.value }],
    };
  },
};

const crossProfileOperation: ManagementCommandDefinition = {
  id: 'test.cross-profile',
  version: 1,
  risk: 'low',
  effect: 'restart',
  prepare({ root, profile }) {
    root.profiles.secondary!.preferences.model = 'forbidden';
    root.profiles[profile]!.preferences.model = 'allowed';
    return { root, changes: [{ field: 'preferences.model', before: 'default', after: 'allowed' }] };
  },
};

const leakingOperation: ManagementCommandDefinition = {
  id: 'test.leaking-summary',
  version: 1,
  risk: 'low',
  effect: 'restart',
  prepare({ root, profile }) {
    root.profiles[profile]!.access.requireMentionInGroup = false;
    return {
      root,
      changes: [{ field: 'unsafe', before: 'super-secret', after: false }],
    };
  },
};

function createService(rootDir: string): ConfigChangeService {
  return new ConfigChangeService({ rootDir, operations: [operation], createId: () => planId });
}

async function createFixture(withSecondary = false): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aria-change-protocol-'));
  roots.push(root);
  const appPaths = resolveAppPaths({ rootDir: root, profile: 'primary' });
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_sensitive', secret: 'super-secret', tenant: 'feishu' } },
    access: { requireMentionInGroup: true },
    codex: { binaryPath: 'codex' },
  });
  const rootConfig = createRootConfig('primary', profile);
  if (withSecondary) rootConfig.profiles.secondary = structuredClone(profile);
  await saveRootConfig(rootConfig, appPaths.configFile);
  await writeActiveProfile(root, 'primary');
  return { root, configPath: appPaths.configFile };
}
