import type { OutboundPolicyContext } from './plugin';

/** Optional, versioned extension to the existing outbound policy ABI. Legacy
 * plugins retain final-only delivery; they never implicitly authorize progress. */
export interface ProgressPolicy {
  readonly apiVersion: 1;
  readonly formats: readonly ProgressFormat[];
  check(input: Readonly<ProgressPolicyInput>): Promise<void>;
}

export type ProgressFormat = 'cot' | 'card';
export interface ProgressPolicyInput {
  readonly format: ProgressFormat;
  readonly phase: 'create' | 'update' | 'complete';
  readonly context: Readonly<OutboundPolicyContext>;
  /** Complete external payload, not uninspected SDK producer callbacks. */
  readonly content: string;
}

export function validateProgressPolicy(value: ProgressPolicy | undefined): void {
  if (value === undefined) return;
  if (value.apiVersion !== 1 || !Array.isArray(value.formats)
    || value.formats.some(format => format !== 'cot' && format !== 'card')
    || new Set(value.formats).size !== value.formats.length || typeof value.check !== 'function') {
    throw new Error('invalid outbound progress policy');
  }
}

export async function checkProgress(policy: ProgressPolicy | undefined, required: boolean,
  input: ProgressPolicyInput): Promise<void> {
  if (!policy) {
    if (required) throw new Error('outbound policy does not support checked progress');
    return;
  }
  // Advertised formats govern new content. Terminal cleanup must still reach
  // the plugin after a format is disabled; its check can permit only the fixed
  // no-content terminal payload backed by the host's ownership receipt.
  if (input.phase !== 'complete' && !policy.formats.includes(input.format)) throw new Error('progress format is unavailable under the outbound policy');
  await policy.check(Object.freeze({ ...input, context: Object.freeze({ ...input.context }) }));
}
