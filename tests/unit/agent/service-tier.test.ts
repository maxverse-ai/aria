import { describe, expect, it } from 'vitest';
import {
  decodeServiceTierSelection,
  encodeServiceTierSelection,
  resolveServiceTier,
  SERVICE_TIER_INHERIT,
  SERVICE_TIER_STANDARD,
} from '../../../src/agent/service-tier.js';

const models = [
  {
    value: 'gpt-fast',
    label: 'GPT Fast',
    isDefault: true,
    serviceTiers: {
      options: [{ value: 'fast', label: 'Fast' }],
    },
  },
  { value: 'gpt-standard', label: 'GPT Standard' },
];

describe('service tier resolution', () => {
  it('keeps inherit, explicit standard, and a named tier distinct', () => {
    expect(decodeServiceTierSelection(SERVICE_TIER_INHERIT)).toBeUndefined();
    expect(decodeServiceTierSelection(SERVICE_TIER_STANDARD)).toBeNull();
    expect(decodeServiceTierSelection('fast')).toBe('fast');
    expect(encodeServiceTierSelection(undefined)).toBe(SERVICE_TIER_INHERIT);
    expect(encodeServiceTierSelection(null)).toBe(SERVICE_TIER_STANDARD);
  });

  it('uses a live model declaration and standardizes an unsupported saved tier', () => {
    const supported = resolveServiceTier(models, 'default', 'fast');
    expect(supported.effective).toBe('fast');
    expect(supported.unsupportedConfiguredTier).toBeUndefined();
    expect(resolveServiceTier(models, 'gpt-standard', 'fast')).toMatchObject({
      effective: null,
      unsupportedConfiguredTier: 'fast',
    });
  });
});
