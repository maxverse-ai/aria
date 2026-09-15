import { expect, it, vi } from 'vitest';
import { larkSpaceNativeTool } from '../../../src/lark-cli/space-tool';
import type { SpaceToolCredentials } from '../../../src/space/tool-credentials';
import type { SpaceOperation } from '../../../src/space/operation-gate';

function fixture(userAuthorization = false) {
  const credentials = {
    isPersonalSpace: vi.fn(() => true),
    identity: { find: vi.fn<SpaceToolCredentials['identity']['find']>(() => undefined) },
    begin: vi.fn(async () => ({ transactionId: 'transaction', verificationUrl: 'https://auth.example/verify', expiresAt: 1000 })),
    complete: vi.fn(async () => undefined), revoke: vi.fn(async () => undefined),
    invoke: vi.fn(async () => ({ stdout: 'fixture', stderr: '', exitCode: 0 })),
  };
  const tool = larkSpaceNativeTool({ authorityId: 'a'.repeat(64), credentials: credentials as unknown as SpaceToolCredentials, userAuthorization });
  const operation = { context: {}, request: { kind: 'direct', senderKind: 'user' } } as SpaceOperation;
  const invoke = (argv: string[]) => tool.invoke(operation, { argv, cwd: '/workspace', signal: new AbortController().signal });
  return { credentials, tool, operation, invoke };
}

it('lets bot-only deployments discover commands without OAuth or an explicit user grant', async () => {
  const f = fixture();
  await f.invoke(['auth', 'login', '--help']);
  expect(f.credentials.invoke).toHaveBeenLastCalledWith(f.operation.context, 'lark', expect.objectContaining({ argv: ['help', 'auth', 'login'], identity: 'bot' }));
  await f.invoke(['skills', 'read', 'lark-doc/SKILL.md', '--as', 'user']);
  expect(f.credentials.invoke).toHaveBeenLastCalledWith(f.operation.context, 'lark', expect.objectContaining({ argv: ['skills', 'read', 'lark-doc/SKILL.md'], identity: 'bot' }));
  expect(f.credentials.begin).not.toHaveBeenCalled();
  expect(f.credentials.identity.find).not.toHaveBeenCalled();
  expect(f.tool.description).toContain('当前部署禁止用户 OAuth');
});

it('keeps bot-only policy effective for both automatic and explicit identity selection', async () => {
  const f = fixture();
  await f.invoke(['drive', '+upload', '--file', 'prototype.zip']);
  expect(f.credentials.invoke).toHaveBeenLastCalledWith(f.operation.context, 'lark', expect.objectContaining({ identity: 'bot' }));
  await expect(f.invoke(['drive', '+upload', '--file', 'prototype.zip', '--as=user'])).rejects.toThrow('deployment identity policy');
  await expect(f.invoke(['auth', 'login', '--no-wait', '--scope=docs:read'])).rejects.toThrow('deployment identity policy');
  expect(f.credentials.begin).not.toHaveBeenCalled();
  expect(f.credentials.invoke).toHaveBeenCalledTimes(1);
});

it('does not extract identity selectors from literal business values', async () => {
  const f = fixture(true);
  await f.invoke(['im', '+send', '--content', '--as', '--title=--profile', '--as', 'user']);
  expect(f.credentials.invoke).toHaveBeenLastCalledWith(f.operation.context, 'lark', expect.objectContaining({
    argv: ['im', '+send', '--content=--as', '--title=--profile'], identity: 'user',
  }));
});

it('accepts split and equal-form scoped OAuth options but still requires a real DM', async () => {
  const f = fixture(true);
  await f.invoke(['auth', 'login', '--no-wait', '--scope', 'docs:read drive:read', '--json']);
  expect(f.credentials.begin).toHaveBeenCalledWith(f.operation.context, 'lark', ['docs:read', 'drive:read'], expect.any(AbortSignal));
  await f.invoke(['auth', 'login', '--device-code=transaction']);
  expect(f.credentials.complete).toHaveBeenCalledWith(f.operation.context, 'lark', 'transaction', expect.any(AbortSignal));
  await expect(f.invoke(['auth', 'login', '--scope=a', '--scope', 'b', '--no-wait'])).rejects.toThrow('invalid scoped authorization option');
  const group = { ...f.operation, request: { ...f.operation.request, kind: 'group' as const } };
  await expect(f.tool.invoke(group, { argv: ['auth', 'login', '--no-wait', '--scope=docs:read'],
    cwd: '/workspace', signal: new AbortController().signal })).rejects.toThrow('私聊');
  expect(f.credentials.begin).toHaveBeenCalledTimes(1);
});


it('reports a durable user binding without an internal expiry', async () => {
  const f = fixture(true);
  f.credentials.identity.find.mockReturnValue({ ref: 'grant', spaceId: 'space', principalId: 'person', providerId: 'lark', credentialRef: 'private-ref' });
  const result = await f.invoke(['auth', 'status', '--json']);
  const status = JSON.parse(result.stdout);
  expect(status).toMatchObject({ identity: 'user', available: true });
  expect(status).not.toHaveProperty('expiresAt');
  expect(result.stdout).not.toContain('private-ref');
});

it('requires user identity for business calls while leaving local inspection available', async () => {
  const f = fixture(true);
  await f.invoke(['docs', 'list']);
  expect(f.credentials.invoke).toHaveBeenLastCalledWith(f.operation.context, 'lark', expect.objectContaining({ identity: 'user' }));
  await expect(f.invoke(['docs', 'list', '--as', 'bot'])).rejects.toThrow('bot business identity is disabled');
  const status = JSON.parse((await f.invoke(['auth', 'status'])).stdout);
  expect(status).toMatchObject({ identity: 'authorization-required', available: false });
  await f.invoke(['help']);
  expect(f.credentials.invoke).toHaveBeenLastCalledWith(f.operation.context, 'lark', expect.objectContaining({ identity: 'bot' }));
});
