import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentTriggerGovernanceApi, FileAgentTriggerGrantStore } from '../../../src/trigger/agent';
import { TriggerManagementApi } from '../../../src/trigger/operations';
import { InMemoryTriggerStateStore } from '../../../src/trigger/state';

const directories: string[] = [];
const operator = { source: 'local-cli' as const, principal: 'operator-a' };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(limits: Record<string, unknown> = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-agent-trigger-'));
  directories.push(rootDir);
  let now = Date.parse('2026-09-03T10:00:00.000Z');
  let grantId = 0;
  let definitionId = 0;
  const state = new InMemoryTriggerStateStore();
  const grantPath = join(rootDir, 'triggers', 'agent-grants.v1.json');
  const management = new TriggerManagementApi({
    rootDir,
    store: state,
    now: () => now,
    createId: () => `definition-${++definitionId}`,
    allowAgentActor: true,
  });
  const governance = new AgentTriggerGovernanceApi({
    rootDir,
    api: management,
    store: new FileAgentTriggerGrantStore(grantPath),
    now: () => now,
    createId: () => grantId++ === 0 ? 'grant-a' : `request-${grantId}`,
    createSecret: () => 'unforgeable-secret',
    supportsEngine: (engine) => engine === 'codex',
  });
  const issued = await governance.issue({
    profileId: 'profile-a',
    engineId: 'codex',
    principal: 'codex-agent-a',
    expiresAt: '2026-09-04T10:00:00.000Z',
    limits,
  }, operator);
  return { governance, issued, state, grantPath, setNow: (value: number) => { now = value; } };
}

function request(token: string, command: 'create' | 'list' | 'history' | 'snooze' | 'update' | 'cancel', input: Record<string, unknown> = {}) {
  return {
    schema: 'aria.agent-trigger.execute.request.v1' as const,
    apiVersion: 1 as const,
    requestId: `agent-${command}`,
    grantToken: token,
    engineId: 'codex',
    command,
    input,
  };
}

describe('AgentTriggerGovernanceApi', () => {
  it('issues a one-time bearer capability and persists only its digest in a private file', async () => {
    const { issued, grantPath } = await fixture();
    expect(issued.token).toBe('grant-a.unforgeable-secret');
    expect(issued.grant).toMatchObject({
      id: 'grant-a',
      profileId: 'profile-a',
      engineId: 'codex',
      capability: 'scheduled-triggers',
      state: 'active',
    });
    expect(JSON.stringify(issued.grant)).not.toContain('codex-agent-a');
    expect((await stat(grantPath)).mode & 0o777).toBe(0o600);
    const persisted = await readFile(grantPath, 'utf8');
    expect(persisted).not.toContain('unforgeable-secret');
    expect(persisted).toContain('tokenDigest');
  });

  it('rewrites untrusted create input to the grant profile, owner and ceilings', async () => {
    const { governance, issued, state } = await fixture({
      maxActiveDefinitions: 2,
      maxRunsPerDay: 3,
      maxRuntimeMs: 5_000,
      maxPromptBytes: 128,
      allowedScheduleKinds: ['once'],
    });
    const created = await governance.execute(request(issued.token, 'create', {
      profileId: 'other-profile',
      ownerRef: 'spoofed-owner',
      createdBy: 'user',
      conversationRef: 'secret-chat',
      maxRuntimeMs: 999_999,
      maxRunsPerDay: 999,
      schedule: { kind: 'once', at: '2026-09-03T11:00:00.000Z' },
      prompt: 'Prepare report',
      label: 'Agent report',
    }));
    const stored = await state.getDefinition(created.definition!.id);
    expect(stored).toMatchObject({
      profileId: 'profile-a',
      ownerRef: 'agent-grant:grant-a:codex-agent-a',
      createdBy: { kind: 'agent', actorRef: 'agent-grant:grant-a:codex-agent-a' },
      authorizationGrantRef: 'agent-trigger-grant:grant-a',
      authorizationCeiling: { maxRuntimeMs: 5_000 },
      quota: { maxRunsPerDay: 3, maxActiveOccurrences: 1 },
    });
    expect(stored?.intentTemplate.resultRoutes).toEqual([{ kind: 'history', routeId: 'history' }]);
    expect(JSON.stringify(stored)).not.toContain('other-profile');
    expect(JSON.stringify(stored)).not.toContain('secret-chat');
    expect((await governance.execute(request(issued.token, 'list'))).snapshot?.definitions).toHaveLength(1);
  });

  it('supports owned update, snooze, history and cancel while blocking cross-owner access', async () => {
    const { governance, issued, state } = await fixture();
    const created = await governance.execute(request(issued.token, 'create', {
      schedule: { kind: 'once', at: '2026-09-03T11:00:00.000Z' },
      prompt: 'First prompt',
    }));
    const id = created.definition!.id;
    await governance.execute(request(issued.token, 'update', { definitionId: id, prompt: 'Updated prompt' }));
    expect((await state.getDefinition(id))?.intentTemplate.input.prompt).toBe('Updated prompt');
    const snoozed = await governance.execute(request(issued.token, 'snooze', {
      definitionId: id,
      at: '2026-09-03T12:00:00.000Z',
    }));
    expect(snoozed.definition?.nextFireAt).toBe(Date.parse('2026-09-03T12:00:00.000Z'));
    expect((await governance.execute(request(issued.token, 'history', { definitionId: id }))).snapshot?.definitions).toHaveLength(1);

    const other = await governance.issue({
      profileId: 'profile-a', engineId: 'codex', principal: 'codex-agent-b',
      expiresAt: '2026-09-04T10:00:00.000Z',
    }, operator);
    await expect(governance.execute(request(other.token, 'cancel', { definitionId: id }))).rejects.toMatchObject({
      code: 'agent-trigger-forbidden',
    });
    expect((await governance.execute(request(issued.token, 'cancel', { definitionId: id }))).definition?.state).toBe('canceled');
  });

  it('enforces engine binding, token validity, expiry, revocation, quotas and content limits', async () => {
    const { governance, issued, setNow } = await fixture({ maxActiveDefinitions: 1, maxPromptBytes: 8 });
    await expect(governance.execute({ ...request('grant-a.wrong', 'list') })).rejects.toMatchObject({
      code: 'invalid-agent-trigger-grant',
    });
    await expect(governance.execute({ ...request(issued.token, 'list'), engineId: 'claude' })).rejects.toMatchObject({
      code: 'invalid-agent-trigger-grant',
    });
    await expect(governance.execute(request(issued.token, 'create', {
      schedule: { kind: 'daily', at: { hour: 9, minute: 0 } }, prompt: 'work',
    }))).rejects.toMatchObject({ code: 'schedule-not-authorized' });
    await expect(governance.execute(request(issued.token, 'create', {
      schedule: { kind: 'once', at: '2026-09-03T11:00:00.000Z' }, prompt: '123456789',
    }))).rejects.toMatchObject({ code: 'invalid-agent-trigger' });
    await governance.execute(request(issued.token, 'create', {
      schedule: { kind: 'once', at: '2026-09-03T11:00:00.000Z' }, prompt: 'work',
    }));
    await expect(governance.execute(request(issued.token, 'create', {
      schedule: { kind: 'once', at: '2026-09-03T12:00:00.000Z' }, prompt: 'work',
    }))).rejects.toMatchObject({ code: 'agent-trigger-quota' });
    await governance.revoke('grant-a', operator);
    await expect(governance.execute(request(issued.token, 'list'))).rejects.toMatchObject({ code: 'invalid-agent-trigger-grant' });
    setNow(Date.parse('2026-09-05T10:00:00.000Z'));
  });

  it('checks grant expiry on every operation', async () => {
    const { governance, issued, setNow } = await fixture();
    setNow(Date.parse('2026-09-04T10:00:00.001Z'));
    await expect(governance.execute(request(issued.token, 'list'))).rejects.toMatchObject({
      code: 'invalid-agent-trigger-grant',
    });
  });

  it('fails closed for unsupported engines, agent-issued grants and direct Management API agent writes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'aria-agent-trigger-deny-'));
    directories.push(rootDir);
    const governance = new AgentTriggerGovernanceApi({
      rootDir,
      now: () => Date.parse('2026-09-03T10:00:00.000Z'),
      supportsEngine: () => false,
    });
    const issue = {
      profileId: 'profile-a', engineId: 'claude', principal: 'agent-a',
      expiresAt: '2026-09-04T10:00:00.000Z',
    };
    await expect(governance.issue(issue, operator)).rejects.toMatchObject({ code: 'unsupported-engine-capability' });
    await expect(governance.issue(issue, { source: 'agent', principal: 'agent-a' })).rejects.toMatchObject({ code: 'grant-admin-required' });

    const management = new TriggerManagementApi({ rootDir });
    await expect(management.execute({
      schema: 'aria.trigger-management.execute.request.v1', apiVersion: 1,
      requestId: 'direct-agent', actor: { source: 'agent', principal: 'agent-a' }, command: 'create',
      input: { profileId: 'profile-a', ownerRef: 'agent-a', prompt: 'work', schedule: { kind: 'once', at: '2026-09-04T10:00:00.000Z' } },
    })).rejects.toMatchObject({ code: 'agent-not-authorized' });
  });
});
