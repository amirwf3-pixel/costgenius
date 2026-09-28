/**
 * Canonical JSON with recursively sorted object keys — a stable value identity for
 * snapshot comparison (same semantics as the canonical-json implementations of the
 * pricebook and calc-engine packages; kept local so this adapter adds no dependency).
 *
 * Used to decide "is the persisted snapshot byte-identical to the incoming aggregate?"
 * for idempotent saves and immutability enforcement. `undefined`-valued properties are
 * dropped (JSON semantics), which matches how the domain objects are constructed.
 */
export function canonicalJson(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === undefined || typeof value === 'function') {
    return 'null'; // JSON semantics for non-serializable leaves
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stringify(v)}`).join(',')}}`;
}
