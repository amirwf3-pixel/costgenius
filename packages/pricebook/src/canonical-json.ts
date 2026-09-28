/**
 * Deterministic canonical JSON: object keys sorted recursively, no insignificant
 * whitespace. Serializing the parsed output again yields the identical string, so a
 * published dataset has one stable byte representation (D-005 reproducibility).
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function canonicalJson(value: unknown): string {
  return serialize(value as Json);
}

function serialize(value: Json): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key] as Json)}`)
    .join(',')}}`;
}
