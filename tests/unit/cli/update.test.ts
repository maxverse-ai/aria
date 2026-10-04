import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runUpdateApply,
  runUpdateCancel,
  runUpdateCheck,
  runUpdatePlan,
  runUpdatePlanShow,
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
  planStatus: vi.fn(),
  cancelPlan: vi.fn(),
  apply: vi.fn(),
  execute: vi.fn(),
  executeRollback: vi.fn(),
  createDistributionRuntime: vi.fn(),
}));

vi.mock('../../../src/composition/distribution', () => ({
  createDistributionRuntime: mocks.createDistributionRuntime,
}));

const release = {
  channel: 'stable' as const,
  repository: 'maxverse-ai/aria',
  tag: 'v0.4.0',
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
      planStatus: mocks.planStatus,
      cancelPlan: mocks.cancelPlan,
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
    expect(output.join('\n')).toContain('current: 0.4.0 (c40d5e7add27)');
    expect(output.join('\n')).toContain('Already on the latest version.');
  });

  it('says no release is available rather than failing when the channel is empty', async () => {
    mocks.check.mockResolvedValue({ current: null, latest: null, updateAvailable: false, reason: 'no-release' });

    await runUpdateCheck();

    expect(output.join('\n')).toContain('No complete, immutable release is available.');
  });

  it('forwards an exact target version into the plan', async () => {
    mocks.createPlan.mockResolvedValue({
      id: 'plan-1',
      expiresAt: '2026-09-16T05:00:00.000Z',
      target: release,
    });

    await runUpdatePlan({ version: '0.3.2' });

    expect(mocks.createPlan).toHaveBeenCalledWith({ version: '0.3.2', force: undefined });
    expect(output.join('\n')).toContain('✓ Update plan created: plan-1');
  });

  it('shows a persisted plan with its lifecycle state', async () => {
    mocks.planStatus.mockResolvedValue({
      plan: {
        id: 'plan-1',
        createdAt: '2026-09-15T05:00:00.000Z',
        expiresAt: '2026-09-16T05:00:00.000Z',
        target: release,
      },
      state: 'active',
      operations: [],
    });

    await runUpdatePlanShow('plan-1');

    expect(mocks.planStatus).toHaveBeenCalledWith('plan-1');
    const text = output.join('\n');
    expect(text).toContain('plan:    plan-1 (active)');
    expect(text).toContain('apply:   aria update apply plan-1');
  });

  it('prints the plan report as JSON when asked', async () => {
    const report = { plan: { id: 'plan-1', target: release }, state: 'cancelled', operations: [] };
    mocks.planStatus.mockResolvedValue(report);

    await runUpdatePlanShow('plan-1', { json: true });

    expect(JSON.parse(output.pop()!)).toEqual(report);
  });

  it('cancels a plan and reports the evidence timestamp', async () => {
    mocks.cancelPlan.mockResolvedValue({
      id: 'plan-1',
      cancelledAt: '2026-09-15T06:00:00.000Z',
      target: release,
    });

    await runUpdateCancel('plan-1');

    expect(mocks.cancelPlan).toHaveBeenCalledWith('plan-1');
    expect(output.join('\n')).toContain('✓ Update plan cancelled: plan-1');
  });

  it('hands a plan to the detached executor, not to the foreground process', async () => {
    mocks.execute.mockResolvedValue({ operationId: 'op-1', detached: true });

    await runUpdateApply('plan-1');

    expect(mocks.execute).toHaveBeenCalledWith('plan-1');
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('status: aria update status op-1');
  });

  it('applies in the foreground only when asked', async () => {
    mocks.apply.mockResolvedValue({ installed: { version: '0.4.0' } });

    await runUpdateApply('plan-1', { foreground: true });

    expect(mocks.apply).toHaveBeenCalledWith('plan-1');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
