import { CompactSign, importJWK, type JWK } from "jose";
import type { Env } from "./env.js";
import { recordActiveKey } from "./service-keys.js";
import type { D1Like } from "./queue/projection.js";

const te = new TextEncoder();

/**
 * Keys this isolate has already published. A Worker has no boot, so the key is
 * remembered on the path every signature passes through, and this keeps that
 * from costing a database write per signature.
 */
const published = new Set<string>();

export async function serviceKey(env: Env) {
  const jwk = JSON.parse(env.THWIP_SERVICE_SIGNING_PRIVATE_JWK) as JWK;
  const kid = jwk.kid ?? "thwip-svc-1";
  if (!published.has(kid)) {
    // A key that has signed is a key a reader must be able to fetch, so it is
    // recorded before the signature exists rather than after.
    await recordActiveKey(env.DB as unknown as D1Like, { ...jwk, kid });
    published.add(kid);
  }
  return { key: await importJWK(jwk, "ES256"), kid };
}

export async function signPayload(env: Env, payload: unknown, typ: string): Promise<string> {
  const { key, kid } = await serviceKey(env);
  return new CompactSign(te.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ES256", kid, typ })
    .sign(key);
}
