import { describe, expect, it } from 'vitest';

import {
  devinCatalogOptions,
  findDevinFamily,
  parseDevinModelCatalog,
  parseDevinVariantTiers,
  resolveDevinModelUid,
  type DevinModelFamily,
} from '../../../src/agent/engines/devin/models';

const CATALOG_JSON = JSON.stringify({
  families: [
    {
      family_label: 'SWE-2',
      family_uid: 'swe-2',
      slug: 'swe-2',
      aliases: ['swe'],
      variants: [
        { model_uid: 'swe-2-high', label: 'SWE-2 High', max_context_tokens: 256000, cost_tier: 'high', cost_summary: '1x' },
        { model_uid: 'swe-2-medium', label: 'SWE-2 Medium', max_context_tokens: 256000, cost_tier: 'medium', cost_summary: '0.5x' },
        { model_uid: 'swe-2-max', label: 'SWE-2 Max', max_context_tokens: 256000, cost_tier: 'max', cost_summary: '2x' },
      ],
    },
    {
      family_label: 'Claude Opus 5',
      family_uid: 'claude-opus-5',
      slug: 'claude-opus-5',
      aliases: ['opus'],
      variants: [
        { model_uid: 'claude-opus-5-low', label: 'Claude Opus 5 Low', cost_summary: '1x' },
        { model_uid: 'claude-opus-5-high', label: 'Claude Opus 5 High', cost_summary: '2x' },
        { model_uid: 'claude-opus-5-high-fast', label: 'Claude Opus 5 High Fast', cost_summary: '4x' },
        { model_uid: 'claude-opus-5-xhigh', label: 'Claude Opus 5 X-High', cost_summary: '3x' },
        { model_uid: 'claude-opus-5-max', label: 'Claude Opus 5 Max', cost_summary: '4x' },
      ],
    },
    {
      family_label: 'SWE-1.6',
      family_uid: 'swe-1-6',
      slug: 'swe-1-6',
      aliases: [],
      variants: [
        { model_uid: 'swe-1-6', label: 'SWE-1.6' },
        { model_uid: 'swe-1-6-fast', label: 'SWE-1.6 Fast' },
      ],
    },
    {
      family_label: 'GPT-5.2',
      family_uid: 'MODEL_GPT_5_2',
      slug: 'gpt-5-2',
      aliases: ['gpt'],
      variants: [
        { model_uid: 'MODEL_GPT_5_2_HIGH', label: 'GPT-5.2 High', cost_summary: '1x' },
        { model_uid: 'MODEL_GPT_5_2_NO_THINKING', label: 'GPT-5.2 No Thinking', cost_summary: '0.5x' },
      ],
    },
    {
      family_label: 'Claude Sonnet 4.6',
      family_uid: 'claude-sonnet-4-6',
      slug: 'claude-sonnet-4-6',
      aliases: [],
      variants: [
        { model_uid: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        { model_uid: 'claude-sonnet-4-6-thinking', label: 'Claude Sonnet 4.6 Thinking' },
        { model_uid: 'claude-sonnet-4-6-thinking-1m', label: 'Claude Sonnet 4.6 Thinking 1M' },
      ],
    },
  ],
});

const FAMILIES: DevinModelFamily[] = [
  {
    slug: 'swe-2',
    label: 'SWE-2',
    aliases: ['swe'],
    variants: [
      { uid: 'swe-2-high', label: 'SWE-2 High', effort: 'high' },
      { uid: 'swe-2-medium', label: 'SWE-2 Medium', effort: 'medium' },
      { uid: 'swe-2-max', label: 'SWE-2 Max', effort: 'max' },
    ],
  },
  {
    slug: 'swe-1-6',
    label: 'SWE-1.6',
    aliases: [],
    variants: [
      { uid: 'swe-1-6', label: 'SWE-1.6' },
      { uid: 'swe-1-6-fast', label: 'SWE-1.6 Fast', speed: 'fast' },
    ],
  },
];

describe('parseDevinVariantTiers', () => {
  it('parses effort tiers from labels', () => {
    expect(parseDevinVariantTiers('SWE-2 High').effort).toBe('high');
    expect(parseDevinVariantTiers('Claude Opus 5 X-High').effort).toBe('xhigh');
    expect(parseDevinVariantTiers('SWE-1.7 Lightning Max').effort).toBe('max');
    expect(parseDevinVariantTiers('Gemini 3 Flash Minimal').effort).toBe('minimal');
    expect(parseDevinVariantTiers('Claude Sonnet 4.6 Thinking').effort).toBe('thinking');
    expect(parseDevinVariantTiers('SWE-2 Medium').effort).toBe('medium');
  });

  it('treats No Thinking / None as the none tier', () => {
    expect(parseDevinVariantTiers('GPT-5.2 No Thinking').effort).toBe('none');
    expect(parseDevinVariantTiers('Nemotron 3 Ultra None').effort).toBe('none');
  });

  it('parses speed tier and combines with effort', () => {
    expect(parseDevinVariantTiers('Claude Opus 5 High Fast')).toEqual({ effort: 'high', speed: 'fast' });
    expect(parseDevinVariantTiers('GPT-5.2 High Priority')).toEqual({ effort: 'high', speed: 'fast' });
    expect(parseDevinVariantTiers('SWE-1.6 Fast')).toEqual({ speed: 'fast' });
    expect(parseDevinVariantTiers('SWE-1.6').effort).toBeUndefined();
  });

  it('reads the earliest tier word in fusion labels', () => {
    expect(parseDevinVariantTiers('Fusion (Claude Fable 5.1 High + SWE-2 Medium)').effort).toBe('high');
  });
});

describe('parseDevinModelCatalog', () => {
  it('parses families, aliases and variant metadata', () => {
    const families = parseDevinModelCatalog(CATALOG_JSON);
    expect(families).toHaveLength(5);
    const swe2 = families[0]!;
    expect(swe2.slug).toBe('swe-2');
    expect(swe2.aliases).toEqual(['swe']);
    expect(swe2.variants.map((v) => v.uid)).toEqual(['swe-2-high', 'swe-2-medium', 'swe-2-max']);
    expect(swe2.variants[0]).toMatchObject({ effort: 'high', contextTokens: 256000, costSummary: '1x' });
  });

  it('keeps irregular uids verbatim', () => {
    const gpt = parseDevinModelCatalog(CATALOG_JSON).find((f) => f.slug === 'gpt-5-2')!;
    expect(gpt.variants.map((v) => v.uid)).toEqual(['MODEL_GPT_5_2_HIGH', 'MODEL_GPT_5_2_NO_THINKING']);
    expect(gpt.variants[1]!.effort).toBe('none');
  });

  it('rejects payloads without a families array', () => {
    expect(() => parseDevinModelCatalog('{}')).toThrow('families');
  });
});

describe('devinCatalogOptions', () => {
  it('emits families plus aliases with reasoning/service-tier capabilities', () => {
    const options = devinCatalogOptions(parseDevinModelCatalog(CATALOG_JSON));
    expect(options[0]!.value).toBe('default');
    const swe2 = options.find((o) => o.value === 'swe-2')!;
    expect(swe2.reasoning?.options.map((o) => o.value)).toEqual(['medium', 'high', 'max']);
    expect(swe2.serviceTiers).toBeUndefined();
    const alias = options.find((o) => o.value === 'swe')!;
    expect(alias.reasoning?.options.map((o) => o.value)).toEqual(['medium', 'high', 'max']);
  });

  it('exposes a fast service tier when a family has fast/priority variants', () => {
    const options = devinCatalogOptions(parseDevinModelCatalog(CATALOG_JSON));
    const opus = options.find((o) => o.value === 'claude-opus-5')!;
    expect(opus.serviceTiers?.options.map((o) => o.value)).toEqual(['fast']);
    const swe16 = options.find((o) => o.value === 'swe-1-6')!;
    expect(swe16.serviceTiers?.options.map((o) => o.value)).toEqual(['fast']);
    expect(swe16.reasoning).toBeUndefined();
  });
});

describe('findDevinFamily', () => {
  const families = parseDevinModelCatalog(CATALOG_JSON);
  it('matches slug, alias and concrete variant uid', () => {
    expect(findDevinFamily(families, 'swe-2')!.slug).toBe('swe-2');
    expect(findDevinFamily(families, 'swe')!.slug).toBe('swe-2');
    expect(findDevinFamily(families, 'swe-2-max')!.slug).toBe('swe-2');
    expect(findDevinFamily(families, 'nope')).toBeUndefined();
  });
});

describe('resolveDevinModelUid', () => {
  const families = parseDevinModelCatalog(CATALOG_JSON);

  it('passes the raw selection through when no effort/speed is set', () => {
    expect(resolveDevinModelUid(families, { model: 'swe' }).model).toBe('swe');
    expect(resolveDevinModelUid(families, { model: 'swe-2-high' }).model).toBe('swe-2-high');
  });

  it('composes family + effort into a concrete variant uid', () => {
    expect(resolveDevinModelUid(families, { model: 'swe-2', effort: 'max' }).model).toBe('swe-2-max');
    expect(resolveDevinModelUid(families, { model: 'swe', effort: 'medium' }).model).toBe('swe-2-medium');
    expect(resolveDevinModelUid(families, { model: 'claude-opus-5', effort: 'xhigh' }).model)
      .toBe('claude-opus-5-xhigh');
  });

  it('composes effort + fast via table lookup, never string concat', () => {
    expect(resolveDevinModelUid(families, { model: 'claude-opus-5', effort: 'high', speed: 'fast' }).model)
      .toBe('claude-opus-5-high-fast');
    expect(resolveDevinModelUid(families, { model: 'gpt-5-2', effort: 'high' }).model)
      .toBe('MODEL_GPT_5_2_HIGH');
  });

  it('composes speed alone', () => {
    expect(resolveDevinModelUid(families, { model: 'swe-1-6', speed: 'fast' }).model)
      .toBe('swe-1-6-fast');
  });

  it('falls back to the raw selection with a warning when no variant matches', () => {
    const result = resolveDevinModelUid(families, { model: 'swe-1-6', effort: 'high' });
    expect(result.model).toBe('swe-1-6');
    expect(result.warnings).toHaveLength(1);
  });

  it('warns when the family is unknown or the catalog is absent', () => {
    expect(resolveDevinModelUid(families, { model: 'mystery', effort: 'high' }).model).toBe('mystery');
    expect(resolveDevinModelUid(undefined, { model: 'swe-2', effort: 'high' }).model).toBe('swe-2');
  });

  it('omits the model when default is selected and warns on set tiers', () => {
    const result = resolveDevinModelUid(families, { model: 'default', effort: 'high' });
    expect(result.model).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(resolveDevinModelUid(families, {}).model).toBeUndefined();
  });

  it('prefers the base-context uid among ambiguous tier matches', () => {
    const result = resolveDevinModelUid(families, { model: 'claude-sonnet-4-6', effort: 'thinking' });
    expect(result.model).toBe('claude-sonnet-4-6-thinking');
  });

  it('treats the default effort sentinel as unset', () => {
    expect(resolveDevinModelUid(families, { model: 'swe-2', effort: 'default' }).model).toBe('swe-2');
    expect(resolveDevinModelUid(FAMILIES, { model: 'swe-2', effort: 'default', speed: 'default' }).model)
      .toBe('swe-2');
  });
});
