import { LEASE_AUDIENCE } from "@thwip/protocol";
import { SignJWT } from "jose";
import type { Env } from "./env.js";
import { serviceKey } from "./service-signing.js";

/**
 * The run lease: this service opening a window for one run.
 *
 * Under `fast` a proof may describe work done at any time on any tree. Every
 * other profile says more than that, and the lease is what carries the
 * difference: the run has to sit inside a window this service opened, for this
 * exact tree, on this exact device, under the policy that was active when the
 * window opened. A proof reused from an earlier commit has no lease naming its
 * tree, and a lease minted after the run finished is old evidence in a fresh
 * wrapper, which the verifier refuses.
 *
 * Minting lives here rather than inside the route so the thing that mints and
 * the thing that checks can be tested against each other.
 */

export interface RunLeaseRequest {
  readonly repositoryId: string;
  readonly treeOid: string;
  readonly parentOids: readonly string[];
  readonly baseSha: string | null;
  readonly deviceKeyId: string;
}

export interface RunLeaseProject {
  readonly activePolicyDigest: string;
  readonly securityProfile: string;
}

export async function mintRunLease(
  env: Env,
  input: {
    readonly project: RunLeaseProject;
    readonly request: RunLeaseRequest;
    /**
     * How long the window stays open. Taken from the policy's
     * `lease.maxAgeSeconds` by the caller: a lease that outlives the age the
     * policy accepts is a token that stops working before it expires, and one
     * with no bound is not a window at all.
     */
    readonly leaseSeconds: number;
  },
): Promise<string> {
  if (!Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) {
    throw new Error("a run lease needs a positive lifetime; the policy did not give one");
  }
  const { key, kid } = await serviceKey(env);
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({
    repositoryId: input.request.repositoryId,
    treeOid: input.request.treeOid,
    parentOids: [...input.request.parentOids],
    baseSha: input.request.baseSha,
    policyDigest: input.project.activePolicyDigest,
    deviceKeyId: input.request.deviceKeyId,
    profile: input.project.securityProfile,
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(env.PUBLIC_ORIGIN)
    .setAudience(LEASE_AUDIENCE)
    .setJti(`lease_${crypto.randomUUID()}`)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(issuedAt + input.leaseSeconds)
    .sign(key);
}
