import { createHash } from 'node:crypto';

/**
 * RFC 8785 (JSON Canonicalization Scheme) serialisation for JSON-compatible values:
 * object keys sorted by UTF-16 code units, no insignificant whitespace, ECMAScript
 * number and string serialisation. Non-JSON values (undefined, functions, NaN,
 * Infinity, bigint) are rejected instead of being silently dropped.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalize: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Bytes(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

export function canonicalSha256Hex(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** Lifecycle fields excluded from the manifest hash (contract README §4.2). */
export const MANIFEST_LIFECYCLE_FIELDS = ['deprecated', 'sunset_at'] as const;

/** manifest_sha256 as defined by the Visual Engine Contract §4.2. */
export function manifestSha256(manifest: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...manifest };
  for (const field of MANIFEST_LIFECYCLE_FIELDS) delete copy[field];
  return canonicalSha256Hex(copy);
}
