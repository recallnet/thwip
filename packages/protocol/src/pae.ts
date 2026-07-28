import { utf8Encode } from "./encoding.js";

/**
 * DSSE v1 pre-authentication encoding:
 * PAE(type, body) = "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body
 */
export function dssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const typeBytes = utf8Encode(payloadType);
  const header = utf8Encode(`DSSEv1 ${typeBytes.length} ${payloadType} ${payload.length} `);
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}
