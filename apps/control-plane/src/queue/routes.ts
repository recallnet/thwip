import { Hono } from "hono";
import { queueKey } from "@thwip/queue-domain";
import type { BranchQueue } from "./BranchQueue.js";
import { verifyVerifierIdentity, type PinnedVerifier } from "./verifier-identity.js";

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

export function queueRoutes<TEnv extends QueueRouteEnv>(deps: {
  /** Who the caller is, from the existing session or bearer auth. */
  authenticate(c: { req: { raw: Request } }, env: TEnv): Promise<
    { ok: true; principalId: string; githubUserId: string; isAdmin: boolean } | { ok: false; status: 401 | 403 }
  >;
  /** Verify a GitHub Actions OIDC token and return its claims. */
  verifyOidc(c: { req: { raw: Request } }, env: TEnv): Promise<Record<string, unknown> | null>;
  /** The pinned verifier identity for a repository, or null when not configured. */
  pinnedVerifier(env: TEnv, repositoryId: string): Promise<PinnedVerifier | null>;
}) {
  const app = new Hono<{ Bindings: TEnv }>();

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
