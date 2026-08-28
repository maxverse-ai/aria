import { describe, expect, it } from 'vitest';
import { getCotMessages, type AppConfig } from '../../../src/config/schema';

describe('COT message preferences', () => {
  it('defaults to detailed when the preference is absent or invalid', () => {
    expect(getCotMessages({} as AppConfig)).toBe('detailed');
    expect(getCotMessages({ preferences: {} } as AppConfig)).toBe('detailed');
    expect(getCotMessages({ preferences: { cotMessages: 'invalid' } } as unknown as AppConfig))
      .toBe('detailed');
  });

  it.each([
    ['off', 'off'],
    ['brief', 'brief'],
    ['simple', 'brief'],
    ['detailed', 'detailed'],
    ['on', 'detailed'],
  ] as const)('resolves %s as %s', (configured, expected) => {
    expect(getCotMessages({ preferences: { cotMessages: configured } } as AppConfig)).toBe(expected);
  });
});
