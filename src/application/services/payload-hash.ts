import { createHash } from "node:crypto";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Canonical JSON: object keys sorted lexicographically (recursively), no
 * whitespace, `undefined` properties omitted. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): Json {
  if (value === null || typeof value !== "object") {
    return value as Json;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(value as object).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortKeys(v);
  }
  return out;
}

/** SHA-256 (hex) of the canonical JSON. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
