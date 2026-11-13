import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({spawn: vi.fn(), health: vi.fn(), alert: vi.fn(), delay: vi.fn(), persist: vi.fn(), close: vi.fn()}));
vi.mock('node:net', () => ({createServer: () => ({once: vi.fn(), listen: (_: string, ready: () => void) => ready(), close: mocks.close})}));
vi.mock('node:fs', () => ({openSync: () => 100, closeSync: vi.fn()}));
vi.mock('node:fs/promises', () => ({mkdir: vi.fn(), readFile: vi.fn().mockRejectedValue(Error('missing')), writeFile: mocks.persist, rename: vi.fn()}));
vi.mock('node:timers/promises', () => ({setTimeout: mocks.delay}));
vi.mock('../../../src/platform/spawn', () => ({spawnProcess: mocks.spawn}));
vi.mock('../../../src/runtime/control-client', () => ({requestRestartPreflight: mocks.health}));
vi.mock('../../../src/daemon/alerts', () => ({sendDaemonAlert: mocks.alert}));
import {runDaemonHost} from '../../../src/daemon/host';

beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(0); vi.clearAllMocks(); mocks.alert.mockResolvedValue(undefined);});
afterEach(() => {vi.useRealTimers();});
function child(pid: number) {return Object.assign(new EventEmitter(), {pid, kill: vi.fn()});}
const options = {serviceId: 'test', directory: '/isolated/daemon', runtimePath: process.execPath, entry: '/fixture/aria.mjs', runArgs: ['run', '--profile', 'test']};
describe('Windows daemon child ownership', () => {
  it('does not kill or replace a live child when readiness fails and sends one deduplicated alert', async () => {
    const processChild = child(123); mocks.spawn.mockReturnValue(processChild); mocks.health.mockRejectedValue(Error('busy/unreachable'));
    let tick = 0;
    mocks.delay.mockImplementation(async () => {vi.setSystemTime(++tick * 30000); if(tick === 4) process.emit('SIGTERM');});
    await runDaemonHost(options);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    // Only explicit shutdown kills; failed readiness never does.
    expect(processChild.kill).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledOnce();
    const states = mocks.persist.mock.calls.map(call => JSON.parse(call[1]));
    expect(states.filter(s => s.status === 'unavailable').every(s => s.childPid === 123)).toBe(true);
  });
  it('waits for definitive exit before replacement and honors crash backoff', async () => {
    const first = child(123), second = child(124); mocks.spawn.mockReturnValueOnce(first).mockReturnValue(second);
    mocks.health.mockResolvedValue({runtimeIdentity: {pid: 124, ready: true}});
    let tick = 0;
    mocks.delay.mockImplementation(async () => {
      tick++;
      if(tick === 1) {vi.setSystemTime(30000); first.emit('exit', 1, null);}
      if(tick === 2) {expect(mocks.spawn).toHaveBeenCalledTimes(1); vi.setSystemTime(60000);}
      if(tick === 4) process.emit('SIGTERM');
    });
    await runDaemonHost(options);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(first.kill).not.toHaveBeenCalled();
    expect(second.kill).toHaveBeenCalled();
  });
});
