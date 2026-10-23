import { describe, expect, it } from 'vitest';
import { resolveWorkerProductIdentity } from '../../../src/worker/identity';

describe('worker product identity', () => {
  it('defaults to Aria and snapshots a host-owned identity', () => {
    expect(resolveWorkerProductIdentity(undefined)).toEqual({ id: 'aria', displayName: 'Aria' });
    const input = { id: 'riff-computer', displayName: ' Riff Computer ' };
    const snapshot = resolveWorkerProductIdentity(input);
    input.displayName = 'changed';
    expect(snapshot).toEqual({ id: 'riff-computer', displayName: 'Riff Computer' });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it.each(['../riff', 'Riff', 'riff/computer', 'riff--computer', '', 'x'.repeat(81)])(
    'rejects unsafe or unstable id %j', (id) => {
      expect(() => resolveWorkerProductIdentity({ id, displayName: 'Riff Computer' })).toThrow();
    },
  );

  it.each(['', '  ', 'Riff\nComputer', 'Riff\u001bComputer', 'x'.repeat(81)])(
    'rejects invalid display name %j', (displayName) => {
      expect(() => resolveWorkerProductIdentity({ id: 'riff-computer', displayName })).toThrow();
    },
  );
});
