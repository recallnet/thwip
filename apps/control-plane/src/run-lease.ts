import { LEASE_AUDIENCE } from "@thwip/protocol";
import { SignJWT } from "jose";
import type { Env } from "./env.js";
import { serviceKey } from "./service-signing.js";
import { acquireProjectWriteLease } from "./project-lifecycle.js";
import type { D1Like } from "./queue/projection.js";

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
  readonly id: string;
  readonly activePolicyDigest: string;
  readonly securityProfile: string;
}

export type WithRunLeaseProjectResult<T> =
  | { readonly kind: "current"; readonly value: T }
  | { readonly kind: "unavailable" }
  | { readonly kind: "released" }
  | { readonly kind: "forbidden" };

export type RunLeaseIdentity = { readonly kind: "admin" } | { readonly kind: "user"; readonly githubUserId: string };

/** Authorize the caller and its device inside the exact project lease before signing. */
export async function withAuthorizedRunLeaseProject<T>(
  db: D1Like,
  repositoryId: string,
  identity: RunLeaseIdentity,
  deviceKeyId: string,
  mint: (projectId: string) => Promise<T>,
  hooks: { readonly beforeFinalAuthorityCheck?: () => Promise<void> } = {},
): Promise<WithRunLeaseProjectResult<T>> {
  const lifecycleLease = await acquireProjectWriteLease(db, repositoryId);
  if (lifecycleLease === null) return { kind: "unavailable" };
  const hasAuthority = async () => {
    const userPredicates = identity.kind === "admin"
      ? ""
      : `AND EXISTS (
             SELECT 1 FROM repository_grants g
              WHERE g.project_id = p.id AND g.github_user_id = ? AND g.active = 1
           )
           AND EXISTS (
             SELECT 1 FROM device_keys k
              WHERE k.key_id = ? AND k.github_user_id = ? AND k.revoked_at IS NULL
           )`;
    const query = db.prepare(
      `SELECT 1 AS allowed
         FROM projects p JOIN organizations o ON o.id = p.organization_id
        WHERE p.id = ? AND p.github_repository_id = ? AND p.enabled = 1 AND o.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
          AND NOT EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = p.github_repository_id)
          ${userPredicates}`,
    );
    const bound = identity.kind === "admin"
      ? query.bind(lifecycleLease.projectId, repositoryId)
      : query.bind(
          lifecycleLease.projectId,
          repositoryId,
          identity.githubUserId,
          deviceKeyId,
          identity.githubUserId,
        );
    return (await bound.first<{ allowed: number }>()) !== null;
  };
  try {
    if (!(await hasAuthority())) return { kind: "forbidden" };
    const value = await mint(lifecycleLease.projectId);
    await lifecycleLease.renew();
    await hooks.beforeFinalAuthorityCheck?.();
    // One D1 statement is the final linearization point: exact incarnation,
    // release fence, grant and device must all be true in the same read.
    if (!(await hasAuthority())) return { kind: "released" };
    return { kind: "current", value };
  } finally {
    await lifecycleLease.release();
  }
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
    projectId: input.project.id,
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
