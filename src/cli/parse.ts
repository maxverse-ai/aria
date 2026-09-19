/**
 * Numeric CLI options arrive as strings. Shared validation so every
 * `--hours`/`--count`/`--lines` style flag is a strict positive integer
 * rather than a silent `Number()` coercion that accepts `1.9` or `1e3`.
 */
export function positiveIntOption(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(trimmed);
}
