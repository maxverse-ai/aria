import {describe, expect, it, vi} from 'vitest';
vi.mock('../../../src/agent/engines/codex/executable', () => ({resolveCodexExecutable: vi.fn(async () => '/desktop/current-hash/codex')}));
import {codexEnginePlugin} from '../../../src/agent/engines/codex/plugin';
describe('Codex bootstrap discovery intent', () => {
  it('validates discovery without persisting its replaceable result', async () => {
    vi.stubEnv('LARK_CHANNEL_CODEX_BIN', 'codex');
    try {
      expect(await codexEnginePlugin.bootstrapConfig!({})).toEqual({binaryPath: 'codex'});
      expect(await codexEnginePlugin.bootstrapConfig!({binaryPath: '/operator/pinned/codex'})).toEqual({binaryPath: '/operator/pinned/codex'});
    } finally {vi.unstubAllEnvs();}
  });
});
