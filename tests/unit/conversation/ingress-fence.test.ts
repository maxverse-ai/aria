import { expect, it } from 'vitest';
import { IngressFence } from '../../../src/conversation/ingress-fence';

it('fences new ingress while accepted callbacks and deferred work finish, then resumes once', async () => {
  const ingress = new IngressFence();
  let finish!: () => void;
  const accepted = ingress.run(() => new Promise<void>(resolve => { finish = resolve; }));
  const resume = ingress.pause();
  expect(ingress.snapshot()).toEqual({ preparingRuns: 1, quiescing: true });
  let executed = false;
  await expect(ingress.run(async () => { executed = true; })).rejects.toThrow('not accepted');
  expect(executed).toBe(false);
  let finishBackground!: () => void;
  const background = ingress.continue(() => new Promise<void>(resolve => { finishBackground = resolve; }));
  finish(); await accepted;
  expect(ingress.snapshot().preparingRuns).toBe(1);
  finishBackground(); await background;
  expect(ingress.snapshot()).toEqual({ preparingRuns: 0, quiescing: true });
  resume(); resume();
  await expect(ingress.run(async () => 'accepted')).resolves.toBe('accepted');
  await expect(ingress.run(async () => { throw new Error('callback failed'); })).rejects.toThrow('callback failed');
  expect(ingress.snapshot()).toEqual({ preparingRuns: 0, quiescing: false });
});
