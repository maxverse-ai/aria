import {
  serviceTierOptionsForModel,
  type ModelOption,
  type ServiceTierOption,
} from './models';

/** Form/management sentinel: do not override the underlying agent config. */
export const SERVICE_TIER_INHERIT = '__inherit__';
/** Form/management sentinel: explicitly clear any configured accelerated tier. */
export const SERVICE_TIER_STANDARD = '__standard__';

export type ServiceTierPreference = string | null | undefined;

export interface ServiceTierResolution {
  options: ServiceTierOption[];
  configured: ServiceTierPreference;
  /** Safe value to pass to an adapter; unsupported configured tiers become standard. */
  effective: ServiceTierPreference;
  unsupportedConfiguredTier?: string;
}

export function encodeServiceTierSelection(value: ServiceTierPreference): string {
  if (value === undefined) return SERVICE_TIER_INHERIT;
  if (value === null) return SERVICE_TIER_STANDARD;
  return value;
}

export function decodeServiceTierSelection(value: unknown): ServiceTierPreference {
  if (value === SERVICE_TIER_INHERIT) return undefined;
  if (value === SERVICE_TIER_STANDARD) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('service tier selection must be inherit, standard, or a non-empty tier id');
  }
  return value.trim();
}

/**
 * Resolve a saved generic tier against the selected model's live catalog.
 * Explicit standard (`null`) is always safe; an unsupported named tier is
 * replaced with explicit standard instead of sending an invalid engine request.
 */
export function resolveServiceTier(
  models: ModelOption[],
  selectedModel: string | undefined,
  configured: ServiceTierPreference,
): ServiceTierResolution {
  const options = serviceTierOptionsForModel(models, selectedModel);
  if (configured === undefined || configured === null) {
    return { options, configured, effective: configured };
  }
  if (options.some((option) => option.value === configured)) {
    return { options, configured, effective: configured };
  }
  return {
    options,
    configured,
    effective: null,
    unsupportedConfiguredTier: configured,
  };
}
