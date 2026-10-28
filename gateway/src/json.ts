/**
 * Deterministic JSON helpers. Cache identity depends on byte-stable
 * serialization, so every key emitted here is sorted recursively.
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  if (value instanceof Date) return value.toISOString();

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortValue(obj[key]);
  }
  return out;
}

/**
 * Deep clone that only walks plain JSON-compatible structures.
 * Anything exotic (Date, Map, class instance) is passed through by reference;
 * MCP payloads are JSON by contract, so this is the honest boundary.
 */
export function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => cloneJson(v)) as unknown as T;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = cloneJson(v);
  }
  return out as unknown as T;
}
