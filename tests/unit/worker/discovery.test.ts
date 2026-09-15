import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { discoverWorkerProfiles } from '../../../src/worker/discovery';

const directories: string[] = [];
async function fixture(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), 'aria-discovery-'));
  directories.push(dir);
  const path = join(dir, 'config.json');
  await writeFile(path, contents);
  return path;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('worker profile discovery', () => {
  it('returns each configured identity without credentials or workspace paths', async () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex', accounts: { app: { id: 'private-id', secret: 'private-secret', tenant: 'feishu' } },
      codex: { binaryPath: '/private/bin/codex' },
    });
    profile.workspaces.default = '/private/workspace';
    const path = await fixture(JSON.stringify({
      schemaVersion: 2, activeProfile: 'jack', preferences: {},
      profiles: { jack: profile, alice: profile, 'bad/ref': profile },
    }));
    expect(await discoverWorkerProfiles(path)).toEqual({
      protocolVersion: 1,
      profiles: [
        { profile: 'alice', engine: 'codex', connectable: true },
        { profile: 'bad/ref', engine: 'codex', connectable: false },
        { profile: 'jack', engine: 'codex', connectable: true },
      ],
    });
  });

  it('does not report unreadable configuration as an empty roster', async () => {
    await expect(discoverWorkerProfiles(await fixture('{}'))).rejects.toThrow('unavailable');
  });

  it('does not disclose malformed configuration in parser errors', async () => {
    await expect(discoverWorkerProfiles(await fixture('private-secret not json')))
      .rejects.toThrow(/^Unable to read Aria configuration$/);
  });
});
