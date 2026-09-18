import { buildAgentLaunchEnv } from '../../launch-env';
import { log } from '../../../core/logger';
import { spawnProcess } from '../../../platform/spawn';
import { DEFAULT_MODEL, type ModelOption } from '../../models';
import { resolveDevinApiKey } from './acp/process';

/**
 * Devin's model catalog is two-layered: a family (`swe-2`, `claude-opus-5`)
 * owns concrete variant uids that encode effort (`-low/-high/-max/…`) and
 * speed (`-fast/-priority`) in the label. `devin models list --format json`
 * is the only live source — the ACP handshake advertises no option list for
 * the `model` config entry — and takes tens of seconds, so fetches run
 * detached behind a short-TTL module cache.
 */

export interface DevinModelVariant {
  uid: string;
  label: string;
  /** Parsed effort axis (low/medium/high/xhigh/max/none/thinking/minimal). */
  effort?: string;
  /** Parsed speed axis; `-fast` and `-priority` both normalize to `fast`. */
  speed?: 'fast';
  contextTokens?: number;
  outputTokens?: number;
  costTier?: string;
  costSummary?: string;
}

export interface DevinModelFamily {
  slug: string;
  label: string;
  aliases: string[];
  variants: DevinModelVariant[];
}

const CATALOG_TTL_MS = 30 * 60 * 1000;
const LIST_TIMEOUT_MS = 120_000;
const LIST_MAX_BYTES = 4 * 1024 * 1024;

/** Matched in declaration order but the earliest position wins, so
 *  `x-high` beats a later `high` and `no thinking` beats bare `thinking`. */
const EFFORT_PATTERNS: readonly [RegExp, string][] = [
  [/x[\s-]?high/i, 'xhigh'],
  [/\bmax\b/i, 'max'],
  [/\bhigh\b/i, 'high'],
  [/\bmedium\b/i, 'medium'],
  [/\blow\b/i, 'low'],
  [/\bminimal\b/i, 'minimal'],
  [/\bno[\s-]?thinking\b|\bnone\b/i, 'none'],
  [/\bthinking\b/i, 'thinking'],
];

/** Display order for the `/effort` picker, weakest to strongest. */
const EFFORT_ORDER: readonly string[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'thinking',
];

const EFFORT_LABELS: Record<string, string> = {
  none: 'None（不推理）',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  thinking: 'Thinking',
};

export function parseDevinVariantTiers(label: string): Pick<DevinModelVariant, 'effort' | 'speed'> {
  let effort: string | undefined;
  let effortIndex = Number.POSITIVE_INFINITY;
  for (const [pattern, tier] of EFFORT_PATTERNS) {
    const match = pattern.exec(label);
    if (match && match.index < effortIndex) {
      effort = tier;
      effortIndex = match.index;
    }
  }
  const speed = /\b(?:fast|priority)\b/i.test(label) ? 'fast' as const : undefined;
  return {
    ...(effort ? { effort } : {}),
    ...(speed ? { speed } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseDevinModelCatalog(json: string): DevinModelFamily[] {
  const doc: unknown = JSON.parse(json);
  if (!isRecord(doc) || !Array.isArray(doc.families)) {
    throw new Error('devin models list: missing families array');
  }
  const families: DevinModelFamily[] = [];
  for (const raw of doc.families) {
    if (!isRecord(raw)) continue;
    const slug = text(raw.slug) ?? text(raw.family_uid);
    if (!slug) continue;
    const variants: DevinModelVariant[] = [];
    if (Array.isArray(raw.variants)) {
      for (const item of raw.variants) {
        if (!isRecord(item)) continue;
        const uid = text(item.model_uid);
        if (!uid) continue;
        const label = text(item.label) ?? uid;
        variants.push({
          uid,
          label,
          ...parseDevinVariantTiers(label),
          ...(typeof item.max_context_tokens === 'number'
            ? { contextTokens: item.max_context_tokens } : {}),
          ...(typeof item.max_output_tokens === 'number'
            ? { outputTokens: item.max_output_tokens } : {}),
          ...(text(item.cost_tier) ? { costTier: text(item.cost_tier) } : {}),
          ...(text(item.cost_summary) ? { costSummary: text(item.cost_summary) } : {}),
        });
      }
    }
    families.push({
      slug,
      label: text(raw.family_label) ?? slug,
      aliases: Array.isArray(raw.aliases)
        ? raw.aliases.map(text).filter((alias): alias is string => Boolean(alias))
        : [],
      variants,
    });
  }
  return families;
}

function familyCapabilities(
  family: DevinModelFamily,
): Pick<ModelOption, 'reasoning' | 'serviceTiers'> {
  const efforts = [...new Set(
    family.variants.map((variant) => variant.effort).filter((tier): tier is string => Boolean(tier)),
  )].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a);
    const ib = EFFORT_ORDER.indexOf(b);
    return (ia === -1 ? EFFORT_ORDER.length : ia) - (ib === -1 ? EFFORT_ORDER.length : ib);
  });
  const hasFast = family.variants.some((variant) => variant.speed === 'fast');
  return {
    ...(efforts.length
      ? {
        reasoning: {
          options: efforts.map((tier) => ({
            value: tier,
            label: EFFORT_LABELS[tier] ?? tier,
            description: family.variants
              .filter((variant) => variant.effort === tier)
              .map((variant) => variant.costSummary)
              .find(Boolean),
          })),
        },
      }
      : {}),
    ...(hasFast
      ? {
        serviceTiers: {
          options: [{
            value: 'fast',
            label: 'Fast（优先通道）',
            description: family.variants
              .map((variant) => variant.speed === 'fast' ? variant.costSummary : undefined)
              .find(Boolean),
          }],
        },
      }
      : {}),
  };
}

/** Aliases first (server-curated "latest" pointers), then every family slug;
 *  concrete uids stay selectable through `/model <uid>` free text. */
export function devinCatalogOptions(families: DevinModelFamily[]): ModelOption[] {
  const options: ModelOption[] = [{ value: DEFAULT_MODEL, label: '跟随默认（不指定）' }];
  const seen = new Set<string>([DEFAULT_MODEL]);
  const push = (value: string, label: string, family: DevinModelFamily) => {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label, ...familyCapabilities(family) });
  };
  for (const family of families) {
    for (const alias of family.aliases) {
      push(alias, `${alias}（${family.label}）`, family);
    }
  }
  for (const family of families) {
    push(family.slug, family.label, family);
  }
  return options;
}

export interface DevinModelResolution {
  /** Model value to hand the engine; `undefined` omits the model flag. */
  model?: string;
  matchedVariant?: DevinModelVariant;
  warnings: string[];
}

export function findDevinFamily(
  families: DevinModelFamily[],
  model: string,
): DevinModelFamily | undefined {
  return families.find((family) =>
    family.slug === model
    || family.aliases.includes(model)
    || family.variants.some((variant) => variant.uid === model));
}

/**
 * Compose family + effort + speed into a concrete variant uid by table
 * lookup. Uids are irregular (`MODEL_GPT_5_2_HIGH`, `-priority` vs `-fast`),
 * so nothing is ever string-concatenated — unmatched combinations degrade
 * to the raw selection, which the server still resolves.
 */
export function resolveDevinModelUid(
  families: DevinModelFamily[] | undefined,
  input: { model?: string; effort?: string; speed?: string | null },
): DevinModelResolution {
  const warnings: string[] = [];
  const model = input.model?.trim();
  const effort = input.effort?.trim() && input.effort !== DEFAULT_MODEL
    ? input.effort.trim() : undefined;
  const speed = input.speed?.trim() && input.speed !== DEFAULT_MODEL
    ? input.speed.trim() : undefined;
  if (!model || model === DEFAULT_MODEL) {
    if (effort || speed) {
      warnings.push('未指定模型时推理/速度档位无法组合，已按服务端默认运行');
    }
    return { warnings };
  }
  const family = families ? findDevinFamily(families, model) : undefined;
  if (!family) {
    if (effort || speed) {
      warnings.push(`模型 ${model} 不在已获取的 Devin 目录中，档位组合按所选模型原样应用`);
    }
    return { model, warnings };
  }
  if (!effort && !speed) {
    return {
      model,
      matchedVariant: family.variants.find((variant) => variant.uid === model),
      warnings,
    };
  }
  const candidates = family.variants.filter((variant) =>
    (effort ? variant.effort === effort : true)
    && (speed ? variant.speed === speed : true));
  if (!candidates.length) {
    warnings.push(`模型 ${model} 没有 ${[effort, speed].filter(Boolean).join(' + ')} 变体，按所选模型原样应用`);
    return { model, warnings };
  }
  // Ambiguous tiers (e.g. `thinking` vs `thinking-1m` context variants)
  // resolve to the shortest uid, which is the base-context variant.
  const matched = candidates.reduce((best, variant) =>
    variant.uid.length < best.uid.length ? variant : best);
  return { model: matched.uid, matchedVariant: matched, warnings };
}

interface CatalogEntry {
  families: DevinModelFamily[];
  fetchedAt: number;
}

const catalogCache = new Map<string, CatalogEntry>();
const catalogInFlight = new Map<string, Promise<DevinModelFamily[] | undefined>>();

function catalogKey(binary: string, apiKeyEnv: string | undefined): string {
  return `${binary}${apiKeyEnv ?? ''}`;
}

async function fetchDevinModelFamilies(
  binary: string,
  apiKeyEnv: string | undefined,
): Promise<DevinModelFamily[]> {
  const apiKey = resolveDevinApiKey(apiKeyEnv);
  const env = buildAgentLaunchEnv(apiKey.key ? { [apiKey.envKey]: apiKey.key } : {});
  const child = spawnProcess(binary, ['models', 'list', '--format', 'json'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise<DevinModelFamily[]>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`devin models list timed out after ${LIST_TIMEOUT_MS}ms`));
    }, LIST_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= LIST_MAX_BYTES) chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(0, 4000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`devin models list exited ${code ?? '?'}: ${stderr.trim() || 'no stderr'}`));
        return;
      }
      try {
        resolve(parseDevinModelCatalog(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** Kick a detached refresh when the cached catalog is stale; never blocks. */
export function ensureDevinModelCatalog(input: {
  binary: string;
  apiKeyEnv?: string;
}): void {
  const key = catalogKey(input.binary, input.apiKeyEnv);
  const cached = catalogCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return;
  if (catalogInFlight.has(key)) return;
  const startedAt = Date.now();
  const promise = fetchDevinModelFamilies(input.binary, input.apiKeyEnv)
    .then((families) => {
      catalogCache.set(key, { families, fetchedAt: Date.now() });
      log.info('devin-models', 'catalog-refresh', {
        familyCount: families.length,
        durationMs: Date.now() - startedAt,
      });
      return families;
    })
    .catch((error) => {
      log.warn('devin-models', 'catalog-refresh-failed', {
        durationMs: Date.now() - startedAt,
        err: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    })
    .finally(() => {
      if (catalogInFlight.get(key) === promise) catalogInFlight.delete(key);
    });
  catalogInFlight.set(key, promise);
}

/** Last fetched families for this binary, when a refresh has completed. */
export function devinModelFamiliesSnapshot(input: {
  binary: string;
  apiKeyEnv?: string;
}): DevinModelFamily[] | undefined {
  return catalogCache.get(catalogKey(input.binary, input.apiKeyEnv))?.families;
}

/** `modelLister` plugin hook: returns the cached catalog instantly and
 *  schedules a background refresh; empty until the first fetch lands. */
export async function listDevinModelOptions(input: {
  binary: string;
  apiKeyEnv?: string;
}): Promise<ModelOption[]> {
  ensureDevinModelCatalog(input);
  const families = devinModelFamiliesSnapshot(input);
  return families ? devinCatalogOptions(families) : [];
}

/** Test hook: drop all cached state. */
export function resetDevinModelCatalogForTests(): void {
  catalogCache.clear();
  catalogInFlight.clear();
}
