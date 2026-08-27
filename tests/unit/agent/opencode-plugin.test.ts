import { describe, expect, it } from 'vitest';
import { resolveOpencodeAutoApprove } from '../../../src/agent/engines/opencode/plugin.js';

describe('resolveOpencodeAutoApprove', () => {
  it('enables --auto for full access', () => {
    expect(resolveOpencodeAutoApprove('full')).toBe(true);
  });

  it('keeps prompts enabled below full access', () => {
    expect(resolveOpencodeAutoApprove('workspace')).toBe(false);
    expect(resolveOpencodeAutoApprove('read-only')).toBe(false);
  });
});
