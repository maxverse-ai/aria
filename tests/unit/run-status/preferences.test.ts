import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_STATUS_ITEMS } from '../../../src/run-status/items.js';
import {
  compactRunStatusPreference,
  getRunStatusItems,
  normalizeRunStatusPreference,
} from '../../../src/run-status/preferences.js';

describe('run status preferences', () => {
  it('shows every status item when the preference is missing', () => {
    expect(getRunStatusItems(undefined)).toEqual(DEFAULT_RUN_STATUS_ITEMS);
    expect(getRunStatusItems({ runStatus: {} })).toEqual(DEFAULT_RUN_STATUS_ITEMS);
  });

  it('preserves explicit empty and canonicalizes custom selections', () => {
    expect(getRunStatusItems({ runStatus: { items: [] } })).toEqual([]);
    expect(normalizeRunStatusPreference({
      items: ['elapsed', 'unknown', 'model', 'elapsed'],
    })).toEqual({ items: ['model', 'elapsed'] });
  });

  it('compacts a full selection to the items-missing/default representation', () => {
    expect(compactRunStatusPreference(DEFAULT_RUN_STATUS_ITEMS)).toEqual({});
    expect(compactRunStatusPreference(['model', 'context'])).toEqual({
      items: ['model', 'context'],
    });
  });
});
