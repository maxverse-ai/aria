import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelInboundEnvelope,
  type ChannelPluginContext,
  type ResolvedChannelInstance,
} from '../../../src/channel/plugin/types';
import {
  createWeixinIlinkPlugin,
  FakeIlinkTransport,
  FileIlinkCredentialStore,
  FileIlinkCursorStore,
  WEIXIN_ILINK_PLUGIN_ID,
  type IlinkInboundMessage,
  type WeixinIlinkConfig,
  type WeixinIlinkRuntime,
} from '../../../channel-plugins/weixin-ilink/src/index';

/**
 * Stage 12D evidence: two independently configured weixin-ilink accounts
 * run side by side through one plugin definition. Every state boundary —
 * credential, cursor, delivery ledger, asset store, proactive scope
 * targets, dedupe sets — is partitioned per instanceId, so account A's
 * traffic, auth lifecycle, and reliability state never leak into B.
 */

const INSTANCE_A = 'wx-account-a';
const INSTANCE_B = 'wx-account-b';
const USER_A = 'wx-user-a';
const USER_B = 'wx-user-b';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ilink-multi-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Account {
  instanceId: string;
  allowedUserId: string;
  credential: { botToken: string; ilinkBotId: string; baseurl: string };
}

const ACCOUNT_A: Account = {
  instanceId: INSTANCE_A,
  allowedUserId: USER_A,
  credential: { botToken: 'token-a', ilinkBotId: 'bot-a', baseurl: 'https://a.example' },
};
const ACCOUNT_B: Account = {
  instanceId: INSTANCE_B,
  allowedUserId: USER_B,
  credential: { botToken: 'token-b', ilinkBotId: 'bot-b', baseurl: 'https://b.example' },
};

function messageFor(account: Account, overrides: Partial<IlinkInboundMessage> = {}): IlinkInboundMessage {
  return {
    message_id: 7001,
    from_user_id: account.allowedUserId,
    create_time_ms: 100,
    session_id: `${account.instanceId}-session`,
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: `hello ${account.instanceId}` } }],
    context_token: `ctx-${account.instanceId}`,
    ...overrides,
  };
}

interface StartedAccount {
  runtime: WeixinIlinkRuntime;
  transport: FakeIlinkTransport;
  envelopes: ChannelInboundEnvelope[];
  stateDir: string;
}

/** Start one account with file-backed stores under the shared stateDir root. */
async function startAccount(
  stateDir: string,
  account: Account,
  configOverrides: Partial<WeixinIlinkConfig> = {},
): Promise<StartedAccount> {
  const transport = new FakeIlinkTransport();
  await new FileIlinkCredentialStore(
    join(stateDir, account.instanceId, 'credential.json'),
  ).write(account.credential);
  const plugin = createWeixinIlinkPlugin({
    transportFor: () => transport,
    stateDir,
    backoffMs: 0,
  });
  const envelopes: ChannelInboundEnvelope[] = [];
  const context: ChannelPluginContext<WeixinIlinkConfig> = {
    instance: {
      profileId: 'primary',
      pluginId: WEIXIN_ILINK_PLUGIN_ID,
      instanceId: account.instanceId,
      enabled: true,
      configVersion: 1,
      config: {
        allowedUserIds: [account.allowedUserId],
        ...configOverrides,
      } as WeixinIlinkConfig,
      secretRefs: {},
    } satisfies ResolvedChannelInstance<WeixinIlinkConfig>,
    ingress: {
      accept: async (envelope) => {
        envelopes.push(envelope);
        return { status: 'accepted', receiptId: `r-${envelopes.length}` };
      },
    },
    signal: new AbortController().signal,
  };
  const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
  return { runtime, transport, envelopes, stateDir };
}

async function waitFor(check: () => boolean, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!check()) throw new Error('condition did not become true');
}

describe('stage 12D multi-account isolation', () => {
  it('routes each account’s traffic to its own instance identity and cursor', async () => {
    const stateDir = await tempDir();
    const a = await startAccount(stateDir, ACCOUNT_A);
    // Seed B's cursor so its lineage is distinguishable from A's.
    const storeA = new FileIlinkCursorStore(join(stateDir, INSTANCE_A, 'cursor.txt'));
    const storeB = new FileIlinkCursorStore(join(stateDir, INSTANCE_B, 'cursor.txt'));
    await storeB.write('b-seed');
    const b = await startAccount(stateDir, ACCOUNT_B);
    try {
      a.transport.push([messageFor(ACCOUNT_A)]);
      b.transport.push([messageFor(ACCOUNT_B)]);
      await waitFor(() => a.envelopes.length === 1 && b.envelopes.length === 1);

      expect(a.envelopes[0]?.instanceId).toBe(INSTANCE_A);
      expect(b.envelopes[0]?.instanceId).toBe(INSTANCE_B);
      expect(a.envelopes[0]?.actorId).toBe(USER_A);
      expect(b.envelopes[0]?.actorId).toBe(USER_B);

      // Each account persists its own cursor under its own directory:
      // B's cursor evolves from B's seed, never from A's lineage.
      const cursorA = await storeA.read();
      const cursorB = await storeB.read();
      expect(cursorA).not.toBe('');
      expect(cursorB.startsWith('b-seed')).toBe(true);
      expect(cursorA.includes('b-seed')).toBe(false);

      // A second batch advances only A's cursor lineage.
      a.transport.push([messageFor(ACCOUNT_A, { message_id: 7002, seq: 2 })]);
      await waitFor(() => a.envelopes.length === 2);
      expect(await storeA.read()).not.toBe(cursorA);
      expect((await storeB.read()).startsWith('b-seed')).toBe(true);
    } finally {
      await a.runtime.close();
      await b.runtime.close();
    }
  });

  it('keeps per-account allowlists: A’s sender is dropped on B', async () => {
    const stateDir = await tempDir();
    const a = await startAccount(stateDir, ACCOUNT_A);
    const b = await startAccount(stateDir, ACCOUNT_B);
    try {
      // Account A's user talks to account B — not on B's allowlist.
      b.transport.push([messageFor(ACCOUNT_B, { from_user_id: USER_A })]);
      await waitFor(() => b.runtime.droppedInbound === 1);
      expect(b.envelopes).toHaveLength(0);
      expect(a.envelopes).toHaveLength(0);
    } finally {
      await a.runtime.close();
      await b.runtime.close();
    }
  });

  it('partitions durable state per instanceId under one stateDir', async () => {
    const stateDir = await tempDir();
    const a = await startAccount(stateDir, ACCOUNT_A);
    const b = await startAccount(stateDir, ACCOUNT_B);
    try {
      a.transport.push([messageFor(ACCOUNT_A)]);
      await waitFor(() => a.envelopes.length === 1);
      await a.runtime.deliver({
        abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
        profileId: 'primary',
        pluginId: WEIXIN_ILINK_PLUGIN_ID,
        instanceId: INSTANCE_A,
        deliveryId: 'd-shared-id',
        sourceMessageId: 'ilink:7001',
        scopeId: `${INSTANCE_A}-session`,
        content: { kind: 'text', text: 'reply a' },
        replyContext: { ilink: { contextToken: 'ctx-a', userId: USER_A } },
      });
      await waitFor(() => a.transport.sent.length === 1);
      const entriesA = await readdir(join(stateDir, INSTANCE_A, 'deliveries'));
      expect(entriesA).toHaveLength(1);

      const dirA = await readdir(join(stateDir, INSTANCE_A));
      const dirB = await readdir(join(stateDir, INSTANCE_B));
      expect(dirA).toEqual(expect.arrayContaining(['credential.json', 'cursor.txt', 'deliveries', 'scope-targets.json']));
      // B never saw traffic: no cursor advance beyond start, no delivery.
      expect(dirB).toContain('credential.json');
      expect(dirB).not.toContain('deliveries');
      await expect(stat(join(stateDir, INSTANCE_B, 'deliveries'))).rejects.toThrow();
    } finally {
      await a.runtime.close();
      await b.runtime.close();
    }
  });

  it('dedupes deliveries per account: the same deliveryId is independent', async () => {
    const stateDir = await tempDir();
    const a = await startAccount(stateDir, ACCOUNT_A);
    const b = await startAccount(stateDir, ACCOUNT_B);
    try {
      const intentFor = (instanceId: string, userId: string) => ({
        abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
        profileId: 'primary',
        pluginId: WEIXIN_ILINK_PLUGIN_ID,
        instanceId,
        deliveryId: 'd-same',
        sourceMessageId: 'ilink:1',
        scopeId: 's',
        content: { kind: 'text' as const, text: `hi ${instanceId}` },
        replyContext: { ilink: { contextToken: 'c', userId } },
      });
      await a.runtime.deliver(intentFor(INSTANCE_A, USER_A));
      await b.runtime.deliver(intentFor(INSTANCE_B, USER_B));
      // Same deliveryId on both accounts → both sends happen; ledgers are
      // per-instance so B's is not deduped away by A's receipt.
      expect(a.transport.sent).toHaveLength(1);
      expect(b.transport.sent).toHaveLength(1);
      // A retry on A dedupes; B is unaffected.
      await a.runtime.deliver(intentFor(INSTANCE_A, USER_A));
      expect(a.transport.sent).toHaveLength(1);
      expect(b.transport.sent).toHaveLength(1);
    } finally {
      await a.runtime.close();
      await b.runtime.close();
    }
  });

  it('keeps proactive scope targets per account', async () => {
    const stateDir = await tempDir();
    const scope = 'shared-scope-id';
    const proactive = {
      proactiveEnabled: true,
      proactiveAllowedScopeIds: [scope],
    } as Partial<WeixinIlinkConfig>;
    const a = await startAccount(stateDir, ACCOUNT_A, proactive);
    const b = await startAccount(stateDir, ACCOUNT_B, proactive);
    try {
      // The scope only produced inbound traffic on account A.
      a.transport.push([messageFor(ACCOUNT_A, { session_id: scope })]);
      await waitFor(() => a.envelopes.length === 1);

      const intentFor = (instanceId: string) => ({
        abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
        profileId: 'primary',
        pluginId: WEIXIN_ILINK_PLUGIN_ID,
        instanceId,
        deliveryId: `d-pro-${instanceId}`,
        scopeId: scope,
        content: { kind: 'text' as const, text: 'proactive' },
      });
      await a.runtime.deliver(intentFor(INSTANCE_A));
      expect(a.transport.sent).toHaveLength(1);

      // B is authorized for the same scope id but has no captured token —
      // it must not borrow A's.
      await expect(b.runtime.deliver(intentFor(INSTANCE_B))).rejects.toSatisfy(
        (error) =>
          error instanceof ChannelPluginError &&
          error.code === 'weixin-ilink-proactive-no-context',
      );
      expect(b.transport.sent).toHaveLength(0);
    } finally {
      await a.runtime.close();
      await b.runtime.close();
    }
  });

  it('fails one account into reauth-required without touching the other', async () => {
    const stateDir = await tempDir();
    const a = await startAccount(stateDir, ACCOUNT_A);
    const b = await startAccount(stateDir, ACCOUNT_B);
    try {
      a.transport.failNextPoll(a.transport.authFailure());
      await waitFor(() => (a.runtime as { snapshot?: unknown }) && a.runtime.snapshot().state === 'reauth-required');
      expect(b.runtime.snapshot().state).toBe('ready');

      // B keeps processing traffic while A waits for reauth.
      b.transport.push([messageFor(ACCOUNT_B)]);
      await waitFor(() => b.envelopes.length === 1);
      expect(a.envelopes).toHaveLength(0);
    } finally {
      await a.runtime.close();
      await b.runtime.close();
    }
  });

  it('does not share dedupe suppression across accounts', async () => {
    const stateDir = await tempDir();
    const a = await startAccount(stateDir, ACCOUNT_A);
    const b = await startAccount(stateDir, ACCOUNT_B);
    try {
      // Same provider message_id on both accounts: each runtime dedupes
      // independently, so both messages are accepted once.
      a.transport.push([messageFor(ACCOUNT_A, { message_id: 42 })]);
      b.transport.push([messageFor(ACCOUNT_B, { message_id: 42 })]);
      await waitFor(() => a.envelopes.length === 1 && b.envelopes.length === 1);
      expect(a.envelopes[0]?.sourceMessageId).toBe('ilink:42');
      expect(b.envelopes[0]?.sourceMessageId).toBe('ilink:42');
    } finally {
      await a.runtime.close();
      await b.runtime.close();
    }
  });
});
