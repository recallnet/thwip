import { Hono } from "hono";
import { queueKey } from "@thwip/queue-domain";
import type { BranchQueue } from "./BranchQueue.js";
import { verifyVerifierIdentity, type PinnedVerifier } from "./verifier-identity.js";
import { projectQueueState, type D1Like, type ProjectionMessage } from "./projection.js";
import { candidateResultDigest, decideCandidate, requiresIntegratedRun } from "./candidate-verdict.js";
import type { CandidateSuite } from "./store.js";

/**
 * The queue's HTTP surface (plan.md §37.1).
 *
 * Every route resolves the Durable Object for one repository and base ref and
 * hands it a command. Nothing decides anything here: this layer authenticates,
 * shapes input, and reports what the object said, so the queue has exactly one
 * writer no matter how many Workers are running.
 */

export interface QueueRouteEnv {
  readonly BRANCH_QUEUE: DurableObjectNamespace<BranchQueue>;
  readonly DB: D1Database;
  readonly PUBLIC_ORIGIN: string;
}

/** Callers supply their own idempotency key, or the route derives a stable one. */
function idempotencyKey(header: string | undefined, fallback: string): string {
  return header !== undefined && header.length > 0 && header.length <= 200 ? header : fallback;
}

function decimal(value: string | undefined): string | null {
  return value !== undefined && /^[0-9]{1,32}$/.test(value) ? value : null;
}

/**
 * The base ref travels as a query parameter rather than a path segment. Cloudflare
 * normalizes a percent-encoded slash in a path back into a real one and issues a
 * redirect, so `refs/heads/main` can never survive as a single path segment. A
 * query value does survive, and it must still name a branch: a queue over a tag
 * or an arbitrary ref is not a protected resource.
 */
function branchRef(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!value.startsWith("refs/heads/") || value.length <= "refs/heads/".length) return null;
  if (value.length > 1024) return null;
  return value;
}

/**
 * Mirror the object's state into D1 after a mutation.
 *
 * The projection exists so organization-wide reads and exports do not have to touch
 * every Durable Object, and it was written and tested but never called — which meant
 * the tables stayed empty and the only way to see queue state was the object itself.
 * Failure here is deliberately swallowed: D1 lagging is expected, and a projection
 * error must never fail the command that already succeeded.
 */
export function projectionMessageFrom(
  repositoryId: string,
  baseRef: string,
  snapshot: Awaited<ReturnType<BranchQueue["snapshot"]>>,
): ProjectionMessage {
  return {
    repositoryId,
    baseRef,
    queueEpoch: snapshot.queueEpoch,
    generation: snapshot.generation,
    entries: snapshot.entries.map((e) => ({
      entryId: e.entryId,
      pullRequestNumber: e.pullRequestNumber,
      sponsorPrincipalId: e.sponsorPrincipalId,
      state: e.state,
      primaryReason: e.primaryReason,
      fairnessOrdinal: e.fairnessOrdinal,
    })),
    // The whole chain, as recorded. An earlier version of this synthesised one
    // row from the head pointer with kind "verified" hardcoded and no prior
    // digest, which meant an external or override transition was projected as
    // verified and the links could not be checked from D1 at all.
    transitions: snapshot.transitions.map((t) => ({
      transitionSequence: t.transitionSequence,
      kind: t.kind,
      digest: t.digest,
      priorDigest: t.priorDigest,
      baseSha: t.baseSha,
      attemptId: t.attemptId,
      witnessCount: t.witnessPrincipalIds.length,
      observedAt: t.recordedAt,
    })),
  };
}

async function project(
  env: QueueRouteEnv,
  repositoryId: string,
  baseRef: string,
  queue: BranchQueue,
): Promise<void> {
  try {
    const snapshot = await queue.snapshot();
    await projectQueueState(
      env.DB as unknown as D1Like,
      projectionMessageFrom(repositoryId, baseRef, snapshot),
    );
  } catch {
    /* the projection may lag; the command already succeeded */
  }
}

async function resolveQueue(
  env: QueueRouteEnv,
  repositoryId: string,
  baseRef: string,
): Promise<BranchQueue> {
  const key = await queueKey(repositoryId, baseRef);
  const stub = env.BRANCH_QUEUE.get(env.BRANCH_QUEUE.idFromName(key)) as unknown as BranchQueue;
  await stub.bind({ queueKey: key, repositoryId, baseRef });
  return stub;
}

/**
 * Turn a thrown error into something a caller can act on.
 *
 * Every one of these used to surface as "Internal Server Error", and diagnosing a
 * single storage constraint failure cost several round trips through a worker tail.
 * The message is safe to return: it names an invariant or a table, never user data.
 */
function failure(error: unknown): { code: string; detail: string; status: 409 | 500 } {
  const detail = error instanceof Error ? error.message : String(error);
  if (/invariant violation/i.test(detail)) return { code: "QUEUE_INVARIANT_VIOLATION", detail, status: 409 };
  if (/UNIQUE constraint|SQLITE_CONSTRAINT/i.test(detail)) {
    return { code: "QUEUE_STORAGE_CONFLICT", detail, status: 409 };
  }
  if (/has not been bound|queue key does not match/i.test(detail)) {
    return { code: "QUEUE_NOT_BOUND", detail, status: 409 };
  }
  return { code: "QUEUE_COMMAND_FAILED", detail, status: 500 };
}

export function queueRoutes<TEnv extends QueueRouteEnv>(deps: {
  /** Who the caller is, from the existing session or bearer auth. */
  authenticate(c: { req: { raw: Request } }, env: TEnv): Promise<
    { ok: true; principalId: string; githubUserId: string; isAdmin: boolean } | { ok: false; status: 401 | 403 }
  >;
  /** Verify a GitHub Actions OIDC token and return its claims. */
  verifyOidc(c: { req: { raw: Request } }, env: TEnv): Promise<Record<string, unknown> | null>;
  /** The pinned verifier identity for a repository, or null when not configured. */
  pinnedVerifier(env: TEnv, repositoryId: string): Promise<PinnedVerifier | null>;
  /**
   * What the active policy requires of a candidate, and which workflow may say it
   * was met. Null when the repository has no active policy, in which case there is
   * nothing to verify against and no merge may be certified.
   */
  activePolicy(
    env: TEnv,
    repositoryId: string,
  ): Promise<{
    policyDigest: string;
    requiredSuites: readonly string[];
    securityProfile: string;
    verifierWorkflowRef: string;
    verifierWorkflowSha: string;
  } | null>;
  /** Ask the pinned verifier to run the required suites against a candidate. */
  dispatchCandidateVerification(
    env: TEnv,
    repositoryId: string,
    payload: {
      baseRef: string;
      pullRequestNumber: number;
      attemptId: string;
      baseSha: string;
      candidateSha: string;
      candidateTreeOid: string;
    },
  ): Promise<void>;
  /** Queue configuration for a branch, or null when the branch has no queue. */
  queueProject(env: TEnv, repositoryId: string, baseRef: string): Promise<{ activationState: string } | null>;
  /** The activated principal for a GitHub user id, or null. */
  principalFor(env: TEnv, githubUserId: string): Promise<string | null>;
  /** Read a commit's tree and parents from GitHub, for confirming from facts. */
  commitFacts(
    env: TEnv,
    repositoryId: string,
    sha: string,
  ): Promise<{ treeOid: string; parentShas: string[] } | null>;
}) {
  const app = new Hono<{ Bindings: TEnv }>();

  // One place where a thrown error becomes a named one.
  app.onError((error, c) => {
    const { code, detail, status } = failure(error);
    return c.json({ error: detail, code }, status);
  });

  /**
   * One call that explains the queue. Added because every diagnosis previously took
   * a state read, a workflow-log grep, and a guess.
   */
  app.get("/v1/queue/:repositoryId/explain", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);
    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);

    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    const report = await queue.diagnose(Number(c.req.query("events") ?? 25));

    // Say why each entry is not schedulable, rather than leaving the reader to work
    // it out from a state name and a timestamp.
    const now = new Date().toISOString();
    const why = report.snapshot.entries.map((e) => ({
      pullRequestNumber: e.pullRequestNumber,
      state: e.state,
      blockedBy:
        e.state === "Merged" || e.state === "Cancelled"
          ? null
          : e.cooldownUntil !== null && e.cooldownUntil > now
            ? `cooling down until ${e.cooldownUntil}`
            : !e.schedulerEligible
              ? (e.primaryReason ?? "not schedulable")
              : report.snapshot.activeAttemptId !== null && e.state === "Ready"
                ? "another entry holds the lane"
                : (e.primaryReason ?? null),
    }));

    return c.json({ ...report, why, now });
  });

  /** Read the queue. Safe for any authenticated member of the repository. */
  app.get("/v1/queue/:repositoryId", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);

    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    return c.json(await queue.snapshot());
  });

  /**
   * Join the queue. Durable: accepted before reviews finish, and the entry keeps
   * its place through failure (plan.md §7.1).
   */
  app.post("/v1/queue/:repositoryId/entries", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);

    const body = (await c.req.json().catch(() => ({}))) as {
      pullRequestNumber?: number;
      headSha?: string;
      sponsorPrincipalId?: string;
      sponsorGithubUserId?: string;
    };
    if (typeof body.pullRequestNumber !== "number" || !Number.isSafeInteger(body.pullRequestNumber)) {
      return c.json({ error: "pullRequestNumber required" }, 400);
    }
    if (typeof body.headSha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(body.headSha)) {
      return c.json({ error: "headSha must be a lowercase hex object id" }, 400);
    }

    // A bot pull request needs a human sponsor, and only an administrator may
    // name a sponsor other than themselves (plan.md §8.1).
    const sponsorPrincipalId = body.sponsorPrincipalId ?? who.principalId;
    const sponsorGithubUserId = body.sponsorGithubUserId ?? who.githubUserId;
    if (sponsorPrincipalId !== who.principalId && !who.isAdmin) {
      return c.json({ error: "only an administrator may sponsor on another principal's behalf" }, 403);
    }

    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    const entryId = `entry_${repositoryId}_${body.pullRequestNumber}`;
    const result = await queue.request({
      idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `request:${entryId}`),
      entryId,
      pullRequestNumber: body.pullRequestNumber,
      sponsorPrincipalId,
      sponsorGithubUserId,
      headSha: body.headSha,
    });
    await project(c.env, repositoryId, baseRef, queue);
    return c.json({ entryId, result }, result.status === "rejected" ? 409 : 202);
  });

  /** Leave the queue, or eject someone as an administrator. */
  app.delete("/v1/queue/:repositoryId/entries/:entryId", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);

    const reason = c.req.query("reason") ?? "withdrawn by the queue owner";
    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    const result = await queue.cancel({
      idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `cancel:${c.req.param("entryId")}`),
      entryId: c.req.param("entryId"),
      actorPrincipalId: who.principalId,
      reason,
    });
    await project(c.env, repositoryId, baseRef, queue);
    return c.json({ result }, result.status === "rejected" ? 409 : 200);
  });

  /**
   * Ask the scheduler whether a turn is due. Idempotent and safe to call often;
   * the object refuses to offer while a lane is busy or the queue is paused.
   */
  app.post("/v1/queue/:repositoryId/tick", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);

    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    const result = await queue.tick({
      idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `tick:${crypto.randomUUID()}`),
      decisionDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    await project(c.env, repositoryId, baseRef, queue);
    return c.json({ result });
  });

  /** Administrative pause, resume, and rebaseline (plan.md §28.5). */
  app.post("/v1/queue/:repositoryId/pause", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);
    if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    if (typeof body.reason !== "string" || body.reason.trim() === "") {
      return c.json({ error: "a pause requires a reason" }, 400);
    }
    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    const result = await queue.pause({
      idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `pause:${crypto.randomUUID()}`),
      actorPrincipalId: who.principalId,
      reason: body.reason,
    });
    return c.json({ result });
  });

  app.post("/v1/queue/:repositoryId/resume", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);
    if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    const result = await queue.resume({
      idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `resume:${crypto.randomUUID()}`),
      actorPrincipalId: who.principalId,
    });
    // A refusal here means a rebaseline is still required after external movement.
    await project(c.env, repositoryId, baseRef, queue);
    return c.json({ result }, result.status === "rejected" ? 409 : 200);
  });

  app.post("/v1/queue/:repositoryId/rebaseline", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);
    if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

    const body = (await c.req.json().catch(() => ({}))) as { baseSha?: string };
    if (typeof body.baseSha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(body.baseSha)) {
      return c.json({ error: "baseSha required" }, 400);
    }
    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    const result = await queue.rebaseline({
      idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `rebaseline:${body.baseSha}`),
      actorPrincipalId: who.principalId,
      baseSha: body.baseSha,
    });
    return c.json({ result });
  });

  /**
   * The verifier's callback. Authenticated by GitHub Actions OIDC and then held
   * to the pinned workflow identity, because any workflow in the repository can
   * obtain a valid token (plan.md §17, §39.2).
   */
  app.post("/api/github-actions/queue-result", async (c) => {
    const claims = await deps.verifyOidc(c, c.env);
    if (claims === null) return c.json({ error: "oidc verification failed" }, 401);

    const body = (await c.req.json().catch(() => ({}))) as {
      repositoryId?: string;
      baseRef?: string;
      attemptId?: string;
      nonce?: string;
      accepted?: boolean;
      resultDigest?: string;
      attemptRevision?: number;
    };
    const repositoryId = decimal(body.repositoryId);
    const baseRef = branchRef(body.baseRef);
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);
    if (typeof body.attemptId !== "string" || typeof body.nonce !== "string") {
      return c.json({ error: "attemptId and nonce required" }, 400);
    }
    if (typeof body.accepted !== "boolean" || typeof body.resultDigest !== "string") {
      return c.json({ error: "accepted and resultDigest required" }, 400);
    }

    const pinned = await deps.pinnedVerifier(c.env, repositoryId);
    if (pinned === null) return c.json({ error: "no verifier is pinned for this repository" }, 409);

    const identity = verifyVerifierIdentity(claims, pinned);
    if (!identity.ok) return c.json({ error: identity.reason, code: "VERIFIER_NOT_PINNED" }, 403);

    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    // A result for an older attempt is stale and harmless; one for the current
    // attempt at a stale revision is a conflict and must not be applied.
    if (typeof body.attemptRevision === "number") {
      const standing = await queue.classifyCallback(body.attemptId, body.attemptRevision);
      if (standing !== "current") return c.json({ error: standing, code: standing }, 409);
    }

    const result = await queue.completeVerification({
      idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `verdict:${body.attemptId}:${identity.jti}`),
      attemptId: body.attemptId,
      nonce: body.nonce,
      accepted: body.accepted,
      resultDigest: body.resultDigest,
    });
    return c.json({ result }, result.status === "rejected" ? 409 : 202);
  });


  /**
   * A pinned verifier reports what the required suites did against one integrated
   * candidate (plan.md §16).
   *
   * This is the evidence the merge gate was missing. Before it existed the gate
   * walked an attempt to merge-ready with a constant standing in for a verifier
   * result, so the queue certified integrations nothing had ever run.
   *
   * The caller does not choose the digest. It is computed here from the reported
   * content, so a verdict cannot claim to be about work other than the work it
   * describes.
   */
  app.post("/v1/queue/:repositoryId/candidate-result", async (c) => {
    const claims = await deps.verifyOidc(c, c.env);
    if (claims === null) return c.json({ error: "oidc verification failed" }, 401);

    const repositoryId = decimal(c.req.param("repositoryId"));
    if (repositoryId === null) return c.json({ error: "invalid repository id" }, 400);
    if (String(claims["repository_id"] ?? "") !== repositoryId) {
      return c.json({ error: "token is for another repository" }, 403);
    }

    const pinned = await deps.pinnedVerifier(c.env, repositoryId);
    if (pinned === null) return c.json({ error: "no verifier is pinned for this repository" }, 409);
    const identity = verifyVerifierIdentity(claims, pinned);
    if (!identity.ok) return c.json({ error: identity.reason, code: "VERIFIER_NOT_PINNED" }, 403);

    const body = (await c.req.json().catch(() => ({}))) as {
      baseRef?: string;
      pullRequestNumber?: number;
      candidateSha?: string;
      candidateTreeOid?: string;
      baseSha?: string;
      accepted?: boolean;
      suites?: Array<{ name?: string; outcome?: string; durationMs?: number }>;
      reasonCodes?: string[];
    };
    const baseRef = branchRef(body.baseRef);
    if (baseRef === null) return c.json({ error: "baseRef must name a branch" }, 400);
    const oid = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v) ? v : null);
    const candidateSha = oid(body.candidateSha);
    const candidateTreeOid = oid(body.candidateTreeOid);
    const baseSha = oid(body.baseSha);
    if (candidateSha === null || candidateTreeOid === null || baseSha === null) {
      return c.json({ error: "candidateSha, candidateTreeOid and baseSha are required" }, 400);
    }
    if (typeof body.accepted !== "boolean") return c.json({ error: "accepted required" }, 400);
    if (typeof body.pullRequestNumber !== "number" || !Number.isSafeInteger(body.pullRequestNumber)) {
      return c.json({ error: "pullRequestNumber required" }, 400);
    }

    const suites: CandidateSuite[] = [];
    for (const raw of body.suites ?? []) {
      if (typeof raw?.name !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(raw.name)) {
        return c.json({ error: "each suite needs a name" }, 400);
      }
      if (raw.outcome !== "passed" && raw.outcome !== "failed" && raw.outcome !== "skipped") {
        return c.json({ error: `suite ${raw.name} has an unknown outcome` }, 400);
      }
      const durationMs = typeof raw.durationMs === "number" && raw.durationMs >= 0 ? raw.durationMs : 0;
      suites.push({ name: raw.name, outcome: raw.outcome, durationMs });
    }
    if (suites.length > 32) return c.json({ error: "too many suites" }, 400);

    const reasonCodes = (body.reasonCodes ?? []).filter(
      (r): r is string => typeof r === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(r),
    );
    // A refusal that will not say why cannot be shown to anyone.
    if (body.accepted === false && reasonCodes.length === 0) {
      return c.json({ error: "a rejected candidate must carry at least one reason code" }, 400);
    }

    const policy = await deps.activePolicy(c.env, repositoryId);
    if (policy === null) return c.json({ error: "no active policy for this repository" }, 409);

    // The identity fields come from the pinned record, which verifyVerifierIdentity
    // has just proved the token matches. Taking them from the token instead would
    // record whatever the caller presented.
    const content = {
      candidateTreeOid,
      candidateSha,
      baseSha,
      pullRequestNumber: body.pullRequestNumber,
      accepted: body.accepted,
      policyDigest: policy.policyDigest,
      suites,
      reasonCodes,
      workflowRef: pinned.workflowRef,
      workflowSha: pinned.workflowSha,
      runId: identity.runId,
    };
    const resultDigest = await candidateResultDigest(content);

    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    const stored = await queue.recordCandidateVerdict({
      ...content,
      resultDigest,
      observedAt: new Date().toISOString(),
    });
    return c.json({ recorded: stored.status, resultDigest, candidateTreeOid }, 202);
  });

  /**
   * The gate the queue decides.
   *
   * Called by the pinned verification workflow, which checks out its own revision
   * rather than the pull request's, so nothing here executes contributor-controlled
   * code. The OIDC token binds the repository, and the event payload comes from
   * GitHub rather than from the branch under test.
   *
   * This is what lets Thwip Queue make real merge decisions without the App being
   * able to publish its own check: the required check that already gates this
   * branch now also asks the queue whether this pull request holds the turn.
   */
  app.post("/v1/queue/:repositoryId/authorize", async (c) => {
    const claims = await deps.verifyOidc(c, c.env);
    if (claims === null) return c.json({ error: "oidc verification failed" }, 401);

    const repositoryId = decimal(c.req.param("repositoryId"));
    if (repositoryId === null) return c.json({ error: "invalid repository id" }, 400);
    const tokenRepositoryId = String(claims["repository_id"] ?? "");
    if (tokenRepositoryId !== repositoryId) {
      return c.json({ error: "token is for another repository" }, 403);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      pullRequestNumber?: number;
      headSha?: string;
      baseRef?: string;
      authorGithubUserId?: string;
      proofAccepted?: boolean;
      draft?: boolean;
      /** The integrated candidate GitHub simulated for this pull request. */
      candidate?: {
        baseSha?: string;
        candidateSha?: string;
        candidateTreeOid?: string;
        parentShas?: string[];
      };
      workReceiptDigest?: string;
      /**
       * Walk the held attempt to the point a merge may be written. Only the caller
       * that is about to write asks for this: preparing earlier starts the
       * merge-confirmation clock while nothing is writing, and the deadline then
       * turns a perfectly good turn into a reconciliation.
       */
      prepare?: boolean;
    };
    const baseRef = branchRef(body.baseRef);
    if (baseRef === null) return c.json({ error: "baseRef must name a branch" }, 400);
    if (typeof body.pullRequestNumber !== "number" || !Number.isSafeInteger(body.pullRequestNumber)) {
      return c.json({ error: "pullRequestNumber required" }, 400);
    }
    if (typeof body.headSha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(body.headSha)) {
      return c.json({ error: "headSha must be a lowercase hex object id" }, 400);
    }

    const project = await deps.queueProject(c.env, repositoryId, baseRef);
    if (project === null) {
      // Not a queue branch: the check must not start failing because a queue was
      // never configured here.
      return c.json({ authorized: true, reason: "QUEUE_NOT_CONFIGURED", enforcing: false });
    }

    const principalId = await deps.principalFor(c.env, String(body.authorGithubUserId ?? ""));
    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    const entryId = `entry_${repositoryId}_${body.pullRequestNumber}`;

    if (principalId !== null) {
      await queue.request({
        idempotencyKey: `authorize:request:${entryId}`,
        entryId,
        pullRequestNumber: body.pullRequestNumber,
        sponsorPrincipalId: principalId,
        sponsorGithubUserId: String(body.authorGithubUserId),
        headSha: body.headSha,
      });
      // Readiness is derived from what the verifier just established plus the
      // branch state. A missing proof is the one thing this caller knows for
      // certain, because it just verified it.
      //
      // The key carries the same time bucket as the tick. Keyed on the head alone,
      // an entry that had been deferred after an unclaimed offer could never be
      // promoted back to Ready, because the only event that promotes it would be
      // deduplicated forever.
      const readyBucket = Math.floor(Date.now() / 60_000);
      await queue.readiness({
        idempotencyKey: `authorize:ready:${entryId}:${body.headSha}:${readyBucket}`,
        entryId,
        ready: body.proofAccepted === true && body.draft !== true,
        schedulerEligible: body.proofAccepted === true && body.draft !== true,
        primaryReason:
          body.draft === true ? "PR_DRAFT" : body.proofAccepted === true ? null : "LOCAL_RECEIPT_MISSING",
      });
      // A time bucket, so a retried check re-evaluates rather than being
      // deduplicated against a decision taken minutes ago, while a burst of
      // parallel jobs for one head still collapses to one turn.
      const bucket = Math.floor(Date.now() / 60_000);
      await queue.tick({
        idempotencyKey: `authorize:tick:${entryId}:${body.headSha}:${bucket}`,
        decisionDigest: `sha256:${"0".repeat(64)}`,
      });

      // Claim the offer on the server's behalf. Nothing else will: in this gate
      // the required check is the consumer, so an unclaimed offer would expire
      // after its deadline and the branch would be told to wait forever. §8.2
      // provides exactly this — a synthetic claim that consumes the sponsor's
      // ordinary turn once and cannot be submitted by a client.
      const offered = await queue.snapshot();
      if (offered.activeAttemptId !== null) {
        const holder = offered.entries.find((e) => e.entryId === entryId);
        if (holder?.state === "Offered") {
          await queue.claim({
            idempotencyKey: `authorize:claim:${offered.activeAttemptId}`,
            attemptId: offered.activeAttemptId,
            executionMode: "fast-reuse",
          });
        }
      }
    }

    // With the lane held, walk the attempt to the point where a merge may be
    // written. The evidence is the proof already on the head, which is the fast
    // profile: this reuses work rather than claiming an integrated run happened.
    let operationId: string | null = null;
    const held = await queue.snapshot();
    const cand = body.candidate;
    if (
      body.prepare === true &&
      held.activeAttemptId !== null &&
      cand?.baseSha !== undefined &&
      cand.candidateSha !== undefined &&
      cand.candidateTreeOid !== undefined
    ) {
      const attemptId = held.activeAttemptId;
      const holder = held.entries.find((e) => e.entryId === entryId);

      // Nothing may be certified until the integrated candidate has actually been
      // run. Until this check existed the walk below used a constant in place of a
      // verifier result, so the queue recorded a verified transition for an
      // integration no suite had ever seen.
      const policy = await deps.activePolicy(c.env, repositoryId);

      // Under the fast profile the policy's own evidence is the proof on the head,
      // so there is nothing further to establish. Under every other profile the
      // queue is about to claim the integration itself was run, and that claim needs
      // a result. A profile that makes the stronger claim with no pinned verifier
      // cannot be satisfied by anything, so it refuses rather than quietly weakening.
      const needsIntegratedRun = policy === null || requiresIntegratedRun(policy.securityProfile);
      let verifiedResultDigest = `sha256:${"3".repeat(64)}`;
      let candidatePolicyDigest = policy?.policyDigest ?? `sha256:${"0".repeat(64)}`;

      if (needsIntegratedRun) {
        if (policy === null) {
          return c.json({
            authorized: false,
            enforcing: true,
            activationState: project.activationState,
            reason: "NO_PINNED_VERIFIER",
            detail: "this profile claims the integrated candidate was run, and nothing can establish that",
            entryId,
            operationId: null,
          });
        }
        const stored = await queue.candidateVerdict(cand.candidateTreeOid);
        const decision = await decideCandidate(stored, {
          candidateTreeOid: cand.candidateTreeOid,
          candidateSha: cand.candidateSha,
          baseSha: cand.baseSha,
          requiredSuites: policy.requiredSuites,
          policyDigest: policy.policyDigest,
          workflowRef: policy.verifierWorkflowRef,
          workflowSha: policy.verifierWorkflowSha,
        });

        if (!decision.ok) {
          // Nothing has run this candidate yet: ask the pinned verifier to, and tell
          // the caller to come back. The caller waits rather than failing, because
          // an untested candidate is a normal early state, not a refusal.
          if (decision.code === "CANDIDATE_NOT_VERIFIED") {
            await deps.dispatchCandidateVerification(c.env, repositoryId, {
              baseRef,
              pullRequestNumber: body.pullRequestNumber,
              attemptId,
              baseSha: cand.baseSha,
              candidateSha: cand.candidateSha,
              candidateTreeOid: cand.candidateTreeOid,
            });
            return c.json({
              authorized: true,
              enforcing: project.activationState !== "observe",
              activationState: project.activationState,
              reason: "HOLDS_TURN",
              candidate: "verification-requested",
              entryId,
              operationId: null,
              retryAfterSeconds: 20,
            });
          }
          return c.json({
            authorized: false,
            enforcing: true,
            activationState: project.activationState,
            reason: decision.code,
            detail: decision.detail,
            entryId,
            operationId: null,
          });
        }
        verifiedResultDigest = decision.resultDigest;
        candidatePolicyDigest = policy.policyDigest;
      }

      if (holder !== undefined && holder.state === "Active") {
        const ok = (r: { status: string }) => r.status === "applied" || r.status === "duplicate";
        const prepared = await queue.candidatePrepared({
          idempotencyKey: `authorize:candidate:${attemptId}`,
          attemptId,
          baseSha: cand.baseSha,
          headSha: body.headSha,
          candidateSha: cand.candidateSha,
          candidateTree: cand.candidateTreeOid,
          policyDigest: candidatePolicyDigest,
          runner: needsIntegratedRun ? "verified-candidate" : "reuse",
        });
        if (ok(prepared)) {
          await queue.assign({
            idempotencyKey: `authorize:assign:${attemptId}`,
            attemptId,
            assignmentDigest: `sha256:${"1".repeat(64)}`,
          });
          await queue.receipt({
            idempotencyKey: `authorize:receipt:${attemptId}`,
            attemptId,
            receiptDigest: body.workReceiptDigest ?? `sha256:${"2".repeat(64)}`,
          });
          const started = await queue.startVerification({
            idempotencyKey: `authorize:verify:${attemptId}`,
            attemptId,
          });
          const nonce = "nonce" in started ? started.nonce : undefined;
          if (nonce !== undefined) {
            await queue.completeVerification({
              idempotencyKey: `authorize:verdict:${attemptId}`,
              attemptId,
              nonce,
              accepted: true,
              // The digest of the verifier's real result for this exact tree.
              resultDigest: verifiedResultDigest,
            });
            await queue.mergeIntent({
              idempotencyKey: `authorize:intent:${attemptId}`,
              attemptId,
              intentDigest: `sha256:${"4".repeat(64)}`,
            });
            const begun = await queue.beginMergeWrite({
              idempotencyKey: `authorize:write:${attemptId}`,
              attemptId,
              operationId: `merge_${attemptId}`,
            });
            if (begun.status === "applied" || begun.status === "already-started") {
              operationId = `merge_${attemptId}`;
            }
          }
        }
      }
    }

    const snapshot = await queue.snapshot();
    const entry = snapshot.entries.find((e) => e.entryId === entryId);

    // An attempt already walked to merge-ready by an earlier caller still has an
    // operation, and the caller that will perform the write needs its id. Without
    // this, the second asker is told it holds the turn and given nothing to act on,
    // so nothing ever merges.
    if (operationId === null && snapshot.activeAttemptId !== null && entry?.state === "Merging") {
      operationId = `merge_${snapshot.activeAttemptId}`;
    }

    // Holding the lane means this entry owns the one active attempt — not merely
    // that some attempt exists, which would authorize whoever asked while another
    // pull request was mid-integration.
    const holdsLane =
      snapshot.activeAttemptId !== null &&
      entry !== undefined &&
      ["Offered", "Active", "Verifying", "MergeGuard", "Merging"].includes(entry.state);
    const enforcing = project.activationState === "canary" || project.activationState === "enforced";

    // In observe the answer is always yes, and the reason says what it would have
    // been. That is what makes adoption reversible.
    const authorized = enforcing ? holdsLane : true;
    return c.json({
      authorized,
      enforcing,
      activationState: project.activationState,
      reason: holdsLane ? "HOLDS_TURN" : (entry?.primaryReason ?? "WAITING_FOR_TURN"),
      entryId,
      operationId,
      queuePosition: snapshot.entries.filter((e) => e.state === "Ready").length,
    });
  });

  /**
   * Operator reconciliation (plan.md §30.4, §68.1).
   *
   * An attempt whose merge outcome is unknown holds the lane until something
   * resolves it, and only two things can: a confirmation, or a person who has
   * looked. This is the second. It requires the operator to say what they observed
   * and why, because declaring a merge did not happen when it did would let the
   * queue certify the same integration twice.
   */
  app.post("/v1/queue/:repositoryId/reconcile", async (c) => {
    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);
    if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const body = (await c.req.json().catch(() => ({}))) as {
      observed?: "merged" | "not-merged" | "merged-outside-the-turn";
      reason?: string;
      /** Required with observed=merged; the facts are read from GitHub, not taken. */
      mergeSha?: string;
    };
    if (typeof body.reason !== "string" || body.reason.trim().length < 8) {
      return c.json({ error: "a reason of at least 8 characters is required" }, 400);
    }

    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    const snapshot = await queue.snapshot();
    const attemptId = snapshot.activeAttemptId;
    if (attemptId === null) return c.json({ error: "no attempt holds the lane" }, 409);

    if (body.observed === "merged") {
      // Confirmed from the commit itself, never from the operator's word. The
      // reducer then refuses any tree that is not the candidate it authorized, so
      // asserting a merge that did not happen cannot certify anything.
      if (typeof body.mergeSha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(body.mergeSha)) {
        return c.json({ error: "mergeSha required to confirm a merge" }, 400);
      }
      const facts = await deps.commitFacts(c.env, repositoryId, body.mergeSha);
      if (facts === null) return c.json({ error: "could not read that commit" }, 404);

      const confirmed = await queue.confirmMerge({
        idempotencyKey: `reconcile:merged:${attemptId}`,
        attemptId,
        operationId: `merge_${attemptId}`,
        mergeSha: body.mergeSha,
        mergeTree: facts.treeOid,
        parentShas: facts.parentShas,
      });
      if (confirmed.status === "rejected") {
        return c.json({ error: confirmed.detail, code: "RESULT_NOT_AUTHORIZED" }, 409);
      }

      const after = await queue.snapshot();
      const sequence = (after.chainHead?.sequence ?? 0) + 1;
      const transition = await queue.recordTransition({
        idempotencyKey: `reconcile:transition:${attemptId}`,
        kind: "verified",
        transitionSequence: sequence,
        priorDigest: after.chainHead?.digest ?? null,
        digest: `sha256:${body.mergeSha.padEnd(64, "0").slice(0, 64)}`,
        baseSha: body.mergeSha,
        attemptId,
        witnessPrincipalIds: [who.principalId],
      });
      return c.json({
        resolved: confirmed.status,
        transition: transition.status,
        sequence,
        attemptId,
        actor: who.principalId,
        reason: body.reason.trim(),
      });
    }

    if (body.observed === "merged-outside-the-turn") {
      // A merge that landed while an attempt was held but had not requested a write.
      // The queue cannot certify it: it never pinned a candidate for it. So the
      // attempt ends and the movement is recorded as external, which is what it was
      // from the chain's point of view — honest rather than flattering.
      if (typeof body.mergeSha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(body.mergeSha)) {
        return c.json({ error: "mergeSha required" }, 400);
      }
      // The entry leaves the queue with the attempt. Terminating the attempt alone
      // left the entry Blocked and still scheduler-eligible, so the queue went on
      // holding a merged pull request as live work and could have offered it a lane.
      // Cancelled rather than Merged: the queue did not merge this and must not
      // claim it did.
      const entryId = (await queue.snapshot()).activeEntryId;
      if (entryId !== null) {
        await queue.cancel({
          idempotencyKey: `outside:cancel:${attemptId}`,
          entryId,
          actorPrincipalId: who.principalId,
          reason: body.reason.trim(),
        });
      } else {
        await queue.terminateAttempt({
          idempotencyKey: `outside:${attemptId}`,
          attemptId,
          outcome: "ADMIN_CANCELLED",
        });
      }
      const after = await queue.snapshot();
      const sequence = (after.chainHead?.sequence ?? 0) + 1;
      const transition = await queue.recordTransition({
        idempotencyKey: `outside:transition:${attemptId}`,
        kind: "external",
        transitionSequence: sequence,
        priorDigest: after.chainHead?.digest ?? null,
        digest: `sha256:${body.mergeSha.padEnd(64, "0").slice(0, 64)}`,
        baseSha: body.mergeSha,
        attemptId: null,
        witnessPrincipalIds: [],
      });
      return c.json({
        resolved: "external",
        transition: transition.status,
        sequence,
        attemptId,
        entryResolved: entryId === null ? "no entry held the lane" : "cancelled",
        note: "recorded as external: the queue held a turn but never pinned a candidate for this merge",
      });
    }

    if (body.observed !== "not-merged") {
      return c.json({ error: 'observed must be "merged", "not-merged", or "merged-outside-the-turn"' }, 400);
    }

    const resolved = await queue.confirmNotMerged({
      idempotencyKey: `reconcile:${attemptId}:${body.reason.trim().slice(0, 32)}`,
      attemptId,
      operationId: `merge_${attemptId}`,
    });
    return c.json({
      resolved: resolved.status,
      attemptId,
      actor: who.principalId,
      reason: body.reason.trim(),
    });
  });

  /**
   * Report that an authorized merge definitely did not happen.
   *
   * Without this the lane stays held: the operation was persisted before the write,
   * the write was refused, and the queue is left reconciling until an operator
   * intervenes. GitHub refusing outright is knowledge, not ambiguity, so the caller
   * that saw the refusal is the right one to resolve it.
   */
  app.post("/v1/queue/:repositoryId/not-merged", async (c) => {
    const claims = await deps.verifyOidc(c, c.env);
    if (claims === null) return c.json({ error: "oidc verification failed" }, 401);
    const repositoryId = decimal(c.req.param("repositoryId"));
    if (repositoryId === null) return c.json({ error: "invalid repository id" }, 400);
    if (String(claims["repository_id"] ?? "") !== repositoryId) {
      return c.json({ error: "token is for another repository" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      baseRef?: string;
      attemptId?: string;
      operationId?: string;
      detail?: string;
    };
    const baseRef = branchRef(body.baseRef);
    if (baseRef === null) return c.json({ error: "baseRef must name a branch" }, 400);
    if (typeof body.attemptId !== "string" || typeof body.operationId !== "string") {
      return c.json({ error: "attemptId and operationId required" }, 400);
    }

    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    // An outcome already in doubt has to be declared unknown before it can be
    // resolved, which is the reducer refusing to skip reconciliation.
    await queue.mergeOutcomeUnknown({
      idempotencyKey: `not-merged:unknown:${body.attemptId}`,
      attemptId: body.attemptId,
    });
    const resolved = await queue.confirmNotMerged({
      idempotencyKey: `not-merged:${body.attemptId}`,
      attemptId: body.attemptId,
      operationId: body.operationId,
    });
    return c.json({ resolved: resolved.status, detail: body.detail ?? null });
  });

  /**
   * Report the merge the queue authorized. The write happens in CI because the App
   * cannot yet merge, so the queue must be told what landed — and it refuses
   * anything that is not the candidate it authorized, which is the guard that makes
   * delegating the write safe.
   */
  app.post("/v1/queue/:repositoryId/merged", async (c) => {
    const claims = await deps.verifyOidc(c, c.env);
    if (claims === null) return c.json({ error: "oidc verification failed" }, 401);
    const repositoryId = decimal(c.req.param("repositoryId"));
    if (repositoryId === null) return c.json({ error: "invalid repository id" }, 400);
    if (String(claims["repository_id"] ?? "") !== repositoryId) {
      return c.json({ error: "token is for another repository" }, 403);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      baseRef?: string;
      attemptId?: string;
      operationId?: string;
      mergeSha?: string;
      mergeTree?: string;
      parentShas?: string[];
      transitionDigest?: string;
      sponsorPrincipalId?: string;
    };
    const baseRef = branchRef(body.baseRef);
    if (baseRef === null) return c.json({ error: "baseRef must name a branch" }, 400);
    for (const [name, value] of [
      ["attemptId", body.attemptId],
      ["operationId", body.operationId],
      ["mergeSha", body.mergeSha],
      ["mergeTree", body.mergeTree],
    ] as const) {
      if (typeof value !== "string" || value.length === 0) return c.json({ error: `${name} required` }, 400);
    }

    const queue = await resolveQueue(c.env, repositoryId, baseRef);
    const confirmed = await queue.confirmMerge({
      idempotencyKey: `merged:${body.attemptId}`,
      attemptId: body.attemptId!,
      operationId: body.operationId!,
      mergeSha: body.mergeSha!,
      mergeTree: body.mergeTree!,
      parentShas: body.parentShas ?? [],
    });
    if (confirmed.status === "rejected") {
      // The reducer refuses a tree that is not the candidate it authorized, so a
      // rejection here means something other than the verified integration landed.
      return c.json({ error: confirmed.detail, code: "RESULT_NOT_AUTHORIZED" }, 409);
    }

    const snapshot = await queue.snapshot();
    const sequence = (snapshot.chainHead?.sequence ?? 0) + 1;
    const transition = await queue.recordTransition({
      idempotencyKey: `transition:${body.attemptId}`,
      kind: "verified",
      transitionSequence: sequence,
      priorDigest: snapshot.chainHead?.digest ?? null,
      digest: body.transitionDigest ?? `sha256:${body.mergeSha!.padEnd(64, "0").slice(0, 64)}`,
      baseSha: body.mergeSha!,
      attemptId: body.attemptId!,
      witnessPrincipalIds: body.sponsorPrincipalId === undefined ? [] : [body.sponsorPrincipalId],
    });

    await project(c.env, repositoryId, baseRef, queue);
    return c.json({ merged: true, confirmed: confirmed.status, transition: transition.status, sequence });
  });

  return app;
}

/**
 * Webhook fan-out (plan.md §42.3). GitHub tells us the world changed; the queue
 * decides what that means. Readiness is re-derived rather than inferred from the
 * event, because an event says what happened and readiness is a conjunction of
 * many current facts.
 */
export interface WebhookOutcome {
  readonly handled: boolean;
  readonly action: "readiness" | "external-transition" | "ignored";
  readonly detail?: string;
}

export function classifyWebhook(event: string, payload: Record<string, unknown>): WebhookOutcome {
  switch (event) {
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_thread":
    case "check_suite":
    case "check_run":
    case "status":
      return { handled: true, action: "readiness" };
    case "push": {
      const ref = payload["ref"];
      // A push to the protected branch that the queue did not cause is external
      // movement, which pauses the lane until an administrator rebaselines.
      return typeof ref === "string" && ref.startsWith("refs/heads/")
        ? { handled: true, action: "external-transition", detail: ref }
        : { handled: false, action: "ignored", detail: "not a branch push" };
    }
    case "repository_ruleset":
      return { handled: true, action: "readiness", detail: "ruleset drift" };
    default:
      return { handled: false, action: "ignored", detail: `unhandled event ${event}` };
  }
}
