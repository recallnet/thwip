import { b64urlDecode, b64urlEncode, utf8Decode, utf8Encode } from "./encoding.js";
import {
  CARRIER_MAX_ENCODED,
  CARRIER_VERSION,
  ENVELOPE_MAX_DECODED,
  TRAILER_KEY,
  type DsseEnvelope,
} from "./types.js";
import { parseEnvelope } from "./schema.js";

export type CarrierError =
  | { code: "PROOF_MISSING" }
  | { code: "PROOF_DUPLICATE" }
  | { code: "PROOF_TOO_LARGE" }
  | { code: "PROOF_MALFORMED"; detail: string }
  | { code: "PROOF_SCHEMA_UNSUPPORTED"; detail: string };

export function encodeCarrier(envelope: DsseEnvelope): string {
  const value = `${CARRIER_VERSION}.${b64urlEncode(utf8Encode(JSON.stringify(envelope)))}`;
  if (value.length > CARRIER_MAX_ENCODED) throw new Error("proof exceeds encoded hard maximum");
  return `${TRAILER_KEY}: ${value}`;
}

/**
 * Extract the single thwip trailer from a full commit message using strict
 * thwip parsing: scan every line for the trailer key; exactly one must exist.
 */
export function extractCarrier(
  commitMessage: string,
): { ok: true; envelope: DsseEnvelope; envelopeRawBytes: Uint8Array } | { ok: false; error: CarrierError } {
  const lines = commitMessage.split("\n");
  const matches: string[] = [];
  for (const line of lines) {
    if (line.startsWith(`${TRAILER_KEY}:`)) {
      matches.push(line.slice(TRAILER_KEY.length + 1).trim());
    }
  }
  if (matches.length === 0) return { ok: false, error: { code: "PROOF_MISSING" } };
  if (matches.length > 1) return { ok: false, error: { code: "PROOF_DUPLICATE" } };
  const value = matches[0]!;
  if (value.length > CARRIER_MAX_ENCODED) return { ok: false, error: { code: "PROOF_TOO_LARGE" } };
  const dot = value.indexOf(".");
  if (dot < 0) return { ok: false, error: { code: "PROOF_MALFORMED", detail: "missing version separator" } };
  const version = value.slice(0, dot);
  if (version !== CARRIER_VERSION) {
    return { ok: false, error: { code: "PROOF_SCHEMA_UNSUPPORTED", detail: `carrier version ${version}` } };
  }
  let bytes: Uint8Array;
  try {
    bytes = b64urlDecode(value.slice(dot + 1));
  } catch {
    return { ok: false, error: { code: "PROOF_MALFORMED", detail: "invalid base64url" } };
  }
  if (bytes.length > ENVELOPE_MAX_DECODED) return { ok: false, error: { code: "PROOF_TOO_LARGE" } };
  let json: unknown;
  try {
    json = JSON.parse(utf8Decode(bytes));
  } catch {
    return { ok: false, error: { code: "PROOF_MALFORMED", detail: "invalid JSON envelope" } };
  }
  const parsed = parseEnvelope(json);
  if (!parsed.ok) return { ok: false, error: { code: "PROOF_MALFORMED", detail: parsed.detail } };
  return { ok: true, envelope: parsed.value, envelopeRawBytes: bytes };
}
