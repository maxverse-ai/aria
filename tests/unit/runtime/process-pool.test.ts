import { expect, it } from 'vitest';
import { ProcessPool } from '../../../src/bot/process-pool';

it('does not release another caller permit on repeated release', async () => {
  const pool = new ProcessPool(() => 1);
  const first = await pool.acquire(); const waiting = pool.acquire();
  first(); const second = await waiting; first();
  expect(pool.tryAcquire()).toBeUndefined();
  expect(pool.snapshot().active).toBe(1);
  second(); expect(pool.snapshot().active).toBe(0);
});

it('honors cap decrease and drains queued callers first after an increase', async () => {
  let cap = 2; const pool = new ProcessPool(() => cap);
  const first = await pool.acquire(); const second = await pool.acquire();
  const third = pool.acquire(); const fourth = pool.acquire();
  cap = 1; first();
  expect(pool.snapshot()).toMatchObject({ active: 1, waiting: 2 });
  cap = 3; const newcomer = pool.tryAcquire();
  const releaseThird = await third; const releaseFourth = await fourth;
  expect(newcomer).toBeUndefined();
  expect(pool.snapshot()).toMatchObject({ active: 3, waiting: 0 });
  second(); releaseThird(); releaseFourth(); expect(pool.snapshot().active).toBe(0);
});
