import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runUpdateApply,
  runUpdateCheck,
  runUpdatePlan,
} from '../../../src/cli/commands/update';

/**
 * The update lifecycle is documented in both READMEs and in
 * `docs/DISTRIBUTION.md` as the way a released installation moves between
 * versions. The private fork disables it, because a machine-private checkout is
 * rolled out by hand instead. That divergence reached this repository once and
 * shipped in 0.4.0, where `aria update check` refused with a pointer to a
 * `local:rollout` script this repository does not have. These tests hold the
 * public wiring to the documented commands.
 */
const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  createPlan: vi.fn(),
  apply: vi.fn(),
  execute: vi.fn(),
  executeRollback: vi.fn(),
  createDistributionRuntime: vi.fn(),
}));

vi.mock('../../../src/composition/distribution', () => ({
  createDistributionRuntime: mocks.createDistributionRuntime,
}));

const release = {
  channel: 'internal' as const,
  repository: 'maxverse-ai/aria',
  tag: 'internal-v0.4.0',
  version: '0.4.0',
  commit: 'c40d5e7add279d8e67271d4c6a52f3c732feb214',
  sha256: 'c09d52ad8448c7992db57e733c8dc33b56ae2813f00627d6c35cbab1a5f6b379',
};

let output: string[];

beforeEach(() => {
  vi.clearAllMocks();
  output = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
  mocks.createDistributionRuntime.mockResolvedValue({
    service: {
      check: mocks.check,
      createPlan: mocks.createPlan,
      apply: mocks.apply,
      rollback: vi.fn(),
      status: vi.fn(),
    },
    executor: { execute: mocks.execute, executeRollback: mocks.executeRollback },
    store: {},
    paths: {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('aria update', () => {
  it('reports the running and latest release instead of refusing to look', async () => {
    mocks.check.mockResolvedValue({
      current: release,
      latest: release,
      updateAvailable: false,
      reason: 'up-to-date',
    });

    await runUpdateCheck();

    expect(mocks.check).toHaveBeenCalledOnce();
    expect(output.join('\n')).toContain('当前版本: 0.4.0 (c40d5e7add27)');
    expect(output.join('\n')).toContain('已经是最新版本。');
  });

  it('says no release is available rather than failing when the channel is empty', async () => {
    mocks.check.mockResolvedValue({ current: null, latest: null, updateAvailable: false, reason: 'no-release' });

    await runUpdateCheck();

    expect(output.join('\n')).toContain('没有可用的完整、不可变内部版本。');
  });

  it('forwards an exact target version into the plan', async () => {
    mocks.createPlan.mockResolvedValue({
      id: 'plan-1',
      expiresAt: '2026-09-16T05:00:00.000Z',
      target: release,
    });

    await runUpdatePlan({ version: '0.3.2' });

    expect(mocks.createPlan).toHaveBeenCalledWith({ version: '0.3.2', force: undefined });
    expect(output.join('\n')).toContain('✓ 更新计划已创建: plan-1');
  });

  it('hands a plan to the detached executor, not to the foreground process', async () => {
    mocks.execute.mockResolvedValue({ operationId: 'op-1', detached: true });

    await runUpdateApply('plan-1');

    expect(mocks.execute).toHaveBeenCalledWith('plan-1');
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('状态: aria update status op-1');
  });

  it('applies in the foreground only when asked', async () => {
    mocks.apply.mockResolvedValue({ installed: { version: '0.4.0' } });

    await runUpdateApply('plan-1', { foreground: true });

    expect(mocks.apply).toHaveBeenCalledWith('plan-1');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
