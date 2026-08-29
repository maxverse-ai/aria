import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigChangeService,
  MANAGEMENT_API_VERSION,
  ManagementApi,
  lowRiskConfigCommandRegistry,
  operationIdForSetting,
  type ControlActorContext,
  type ManagementPlanRequest,
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
const actor: ControlActorContext = { source: 'agent', principal: 'management-api-test' };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ManagementApi', () => {
  it('drives plan, read, confirm, and commit through versioned envelopes', async () => {
    const fixture = await createFixture();
    const api = createApi(fixture.root, '11111111111111111111111111111111');

    const planned = await api.plan(planRequest('request-plan'));
    expect(planned).toMatchObject({
      schema: 'aria.management.plan.v1',
      apiVersion: 1,
      requestId: 'request-plan',
      plan: { id: '11111111111111111111111111111111', status: 'planned' },
    });
    expect((await loadRootConfig(fixture.configPath))?.profiles.primary?.preferences.cotMessages)
      .not.toBe('brief');

    const read = await api.getPlan({
      schema: 'aria.management.plan-read.request.v1',
      apiVersion: MANAGEMENT_API_VERSION,
      requestId: 'request-read',
      actor,
      planId: planned.plan.id,
    });
    expect(read).toMatchObject({ requestId: 'request-read', plan: { status: 'planned' } });

    const confirmed = await api.confirm({
      schema: 'aria.management.confirm.request.v1',
      apiVersion: MANAGEMENT_API_VERSION,
      requestId: 'request-confirm',
      actor,
      planId: planned.plan.id,
    });
    expect(confirmed).toMatchObject({ requestId: 'request-confirm', plan: { status: 'confirmed' } });

    const committed = await api.commit({
      schema: 'aria.management.commit.request.v1',
      apiVersion: MANAGEMENT_API_VERSION,
      requestId: 'request-commit',
      actor,
      planId: planned.plan.id,
    });
    expect(committed).toMatchObject({
      schema: 'aria.management.commit.v1',
      apiVersion: 1,
      requestId: 'request-commit',
      effect: 'restart',
      applyResult: { planId: '11111111111111111111111111111111', recovered: false },
    });
    expect((await loadRootConfig(fixture.configPath))?.profiles.primary?.preferences.cotMessages)
      .toBe('brief');
  });

  it('offers execute as the functional one-call adapter path', async () => {
    const fixture = await createFixture();
    const api = createApi(fixture.root, '22222222222222222222222222222222');

    const result = await api.execute({
      schema: 'aria.management.execute.request.v1',
      apiVersion: MANAGEMENT_API_VERSION,
      requestId: 'request-execute',
      actor,
      command: operationIdForSetting('show-tool-calls'),
      input: { value: false },
    });

    expect(result).toMatchObject({
      schema: 'aria.management.execute.v1',
      apiVersion: 1,
      requestId: 'request-execute',
      planId: '22222222222222222222222222222222',
      effect: 'restart',
      applyResult: { planId: '22222222222222222222222222222222' },
    });
    expect((await loadRootConfig(fixture.configPath))?.profiles.primary?.preferences.showToolCalls)
      .toBe(false);
  });

  it('rejects malformed request metadata before reaching the mutation kernel', async () => {
    const fixture = await createFixture();
    const api = createApi(fixture.root, '33333333333333333333333333333333');

    await expect(
      api.plan({ ...planRequest('bad request id'), apiVersion: 2 } as unknown as ManagementPlanRequest),
    ).rejects.toMatchObject({ code: 'unsupported-version' });
    await expect(api.plan(planRequest('bad request id'))).rejects.toMatchObject({
      code: 'invalid-request',
    });
  });
});

function planRequest(requestId: string): ManagementPlanRequest {
  return {
    schema: 'aria.management.plan.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId,
    actor,
    command: operationIdForSetting('cot-messages'),
    input: { value: 'brief' },
  };
}

function createApi(rootDir: string, planId: string): ManagementApi {
  return new ManagementApi(
    new ConfigChangeService({
      rootDir,
      registry: lowRiskConfigCommandRegistry,
      createId: () => planId,
    }),
  );
}

async function createFixture(): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aria-management-api-'));
  roots.push(root);
  const appPaths = resolveAppPaths({ rootDir: root, profile: 'primary' });
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'secret-test', tenant: 'feishu' } },
    access: { requireMentionInGroup: true },
    codex: { binaryPath: 'codex' },
  });
  await saveRootConfig(createRootConfig('primary', profile), appPaths.configFile);
  await writeActiveProfile(root, 'primary');
  return { root, configPath: appPaths.configFile };
}
