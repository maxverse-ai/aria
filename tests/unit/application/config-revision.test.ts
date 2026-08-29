import { describe, expect, it } from 'vitest';
import { configRevision } from '../../../src/application/control';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig } from '../../../src/config/profile-store';

describe('configRevision', () => {
  it('assigns a stable semantic revision to missing root state', () => {
    expect(configRevision(undefined)).toBe(configRevision(undefined));
    expect(configRevision(undefined)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('is stable across semantically equivalent object key order', () => {
    const root = createRootConfig(
      'primary',
      createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: { app: { id: 'cli_test', secret: 'secret-test', tenant: 'feishu' } },
        codex: { binaryPath: 'codex' },
      }),
    );
    root.profiles.primary!.preferences = {
      showToolCalls: false,
      messageReply: 'text',
      messageReplyMigrated: true,
      maxConcurrentRuns: 7,
    };
    const reordered = structuredClone(root);
    reordered.profiles.primary!.preferences = {
      maxConcurrentRuns: 7,
      messageReplyMigrated: true,
      messageReply: 'text',
      showToolCalls: false,
    };

    expect(configRevision(reordered)).toBe(configRevision(root));
  });
});
