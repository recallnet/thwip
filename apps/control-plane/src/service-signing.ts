import { CompactSign, importJWK, type JWK } from "jose";
import type { Env } from "./env.js";

const te = new TextEncoder();

export async function serviceKey(env: Env) {
  const jwk = JSON.parse(env.THWIP_SERVICE_SIGNING_PRIVATE_JWK) as JWK;
  return { key: await importJWK(jwk, "ES256"), kid: jwk.kid ?? "thwip-svc-1" };
}

export async function signPayload(env: Env, payload: unknown, typ: string): Promise<string> {
  const { key, kid } = await serviceKey(env);
  return new CompactSign(te.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ES256", kid, typ })
    .sign(key);
}
