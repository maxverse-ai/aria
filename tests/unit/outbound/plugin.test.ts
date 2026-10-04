import type { LarkChannel } from '@larksuite/channel';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadOutboundPolicy,
  isOutboundPolicyRequired,
  OUTBOUND_POLICY_MODULE_ENV,
  OUTBOUND_POLICY_REQUIRED_ENV,
} from '../../../src/outbound/plugin.js';

function channel(): LarkChannel {
  return {
    send: vi.fn(async () => ({ messageId: 'om_1' })),
    disconnect: vi.fn(async () => undefined),
  } as unknown as LarkChannel;
}

const moduleRoots: string[] = [];

// Real files, not data: URLs — bun does not expose a default export through
// `import('data:text/javascript,...')`, while file modules behave the same
// on both runtimes.
async function moduleUrl(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aria-policy-'));
  moduleRoots.push(root);
  const file = join(root, `policy-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, body, 'utf8');
  return pathToFileURL(file).href;
}

afterEach(async () => {
  delete (globalThis as Record<string, unknown>).__ariaPolicyMeta;
  delete (globalThis as Record<string, unknown>).__ariaPolicyContext;
  delete (globalThis as Record<string, unknown>).__ariaPolicyClosed;
  for (const root of moduleRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('outbound policy loader', () => {
  it('parses the mandatory deployment boundary without accepting loose truthy values', () => {
    expect(isOutboundPolicyRequired({ [OUTBOUND_POLICY_REQUIRED_ENV]: '1' })).toBe(true);
    expect(isOutboundPolicyRequired({ [OUTBOUND_POLICY_REQUIRED_ENV]: 'true' })).toBe(true);
    expect(() => isOutboundPolicyRequired({ [OUTBOUND_POLICY_REQUIRED_ENV]: 'yes' })).toThrow(
      'must be 0, 1, false, or true',
    );
    expect(isOutboundPolicyRequired({ [OUTBOUND_POLICY_REQUIRED_ENV]: '0' })).toBe(false);
    expect(isOutboundPolicyRequired({})).toBe(false);
  });

  it('is pass-through when no policy module is configured', async () => {
    await expect(loadOutboundPolicy(channel(), {
      profile: 'aria',
      appId: 'cli_test',
      tenant: 'feishu',
    }, {})).resolves.toBeUndefined();
  });

  it('fails closed when a policy is required but absent', async () => {
    await expect(loadOutboundPolicy(channel(), {
      profile: 'aria',
      appId: 'cli_test',
      tenant: 'feishu',
    }, { [OUTBOUND_POLICY_REQUIRED_ENV]: '1' })).rejects.toThrow(
      `${OUTBOUND_POLICY_MODULE_ENV} is required`,
    );
  });

  it('loads the v2 ABI, validates coverage, scopes work, and closes once', async () => {
    const rawChannel = channel();
    const specifier = await moduleUrl(`
      export default async function(meta) {
        globalThis.__ariaPolicyMeta = meta;
        return {
          id: 'fixture-policy',
          apiVersion: 2,
          protectedSinks: ['message.send','message.stream','card.create','card.update','comment.reply','attachment.upload'],
          excludedSinks: ['cot','direct_lark_cli'],
          streamStrategy: 'final-only',
          wrapChannel(channel) {
            return new Proxy(channel, {
              get(target, property, receiver) {
                if (property === '__ariaAdminControlChannel') return channel;
                return Reflect.get(target, property, receiver);
              },
            });
          },
          withContext(context, operation) {
            globalThis.__ariaPolicyContext = context;
            return operation();
          },
          defer(operation) { void operation(); },
          close() { globalThis.__ariaPolicyClosed = (globalThis.__ariaPolicyClosed ?? 0) + 1; },
        };
      }
    `);
    const loaded = await loadOutboundPolicy(rawChannel, {
      profile: 'aria',
      appId: 'cli_test',
      tenant: 'feishu',
    }, { [OUTBOUND_POLICY_MODULE_ENV]: specifier });

    expect(loaded?.streamStrategy).toBe('final-only');
    expect(loaded?.controlChannel).toBe(rawChannel);
    expect((globalThis as Record<string, unknown>).__ariaPolicyMeta).toMatchObject({
      apiVersion: 2,
      profile: 'aria',
      appId: 'cli_test',
      tenant: 'feishu',
    });
    const context = {
      source: 'im' as const,
      senderOpenId: 'ou_user',
      sourceMessageId: 'om_source',
      conversationId: 'oc_chat',
      runId: 'message:om_source',
    };
    expect(loaded?.run(context, () => 'ok')).toBe('ok');
    expect((globalThis as Record<string, unknown>).__ariaPolicyContext).toEqual(context);

    await loaded?.close();
    await loaded?.close();
    expect((globalThis as Record<string, unknown>).__ariaPolicyClosed).toBe(1);
  });

  it('rejects a plugin that does not cover the exact stable sink set', async () => {
    const specifier = await moduleUrl(`
      export default async function() {
        return {
          id: 'incomplete-policy', apiVersion: 2,
          protectedSinks: ['message.send'], excludedSinks: ['cot','direct_lark_cli'],
          streamStrategy: 'final-only',
          wrapChannel(channel) { return channel; },
          withContext(_context, operation) { return operation(); },
          defer(operation) { void operation(); },
        };
      }
    `);
    await expect(loadOutboundPolicy(channel(), {
      profile: 'aria', appId: 'cli_test', tenant: 'feishu',
    }, { [OUTBOUND_POLICY_MODULE_ENV]: specifier })).rejects.toThrow(
      'protectedSinks mismatch',
    );
  });
});
