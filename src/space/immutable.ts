/** Freeze host-owned JSON values, including nested authority and binding keys. */
export function immutable<T>(input: T): T {
  const value = structuredClone(input);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const nested of Object.values(item)) freeze(nested);
    Object.freeze(item);
  };
  freeze(value);
  return value;
}
