import canonicalizeModule from "canonicalize";
const canonicalize = canonicalizeModule as unknown as (value: unknown) => string | undefined;
import { sha256Hex, utf8Encode } from "./encoding.js";
import type { Sha256 } from "./types.js";

/** RFC 8785 canonical JSON digest for thwip policy/pipeline material. */
export async function canonicalDigest(value: unknown): Promise<Sha256> {
  const canon = canonicalize(value);
  if (canon === undefined) throw new Error("value is not canonicalizable");
  return `sha256:${await sha256Hex(utf8Encode(canon))}`;
}

/**
 * The canonical JSON text a digest is taken over. Exported so a caller that must
 * store the exact bytes behind a digest can get them from the same place the
 * digest comes from, rather than re-serializing and hoping the two agree.
 */
export function canonicalJson(value: unknown): string {
  const canon = canonicalize(value);
  if (canon === undefined) throw new Error("value is not canonicalizable");
  return canon;
}

export async function bytesDigest(bytes: Uint8Array): Promise<Sha256> {
  return `sha256:${await sha256Hex(bytes)}`;
}
