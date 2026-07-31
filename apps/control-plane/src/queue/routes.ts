import { Hono } from "hono";
import { queueKey } from "@thwip/queue-domain";
import type { BranchQueue } from "./BranchQueue.js";
import { verifyVerifierIdentity, type PinnedVerifier } from "./verifier-identity.js";
import {
  projectQueueState,
  readProjectedQueue,
  type D1Like,
  type ProjectionMessage,
} from "./projection.js";
import { adoptChain, readProjectedChain } from "./adopt-chain.js";
import {
  admit,
  buildSnapshot,
  commandsFor,
  confirmOnly,
  recordOnly,
  diagnose,
  walkToMergeReady,
  type QueueSnapshot,
} from "./queue-operations.js";
import { loadQueueState, withQueueState } from "./queue-state.js";
import { turnCheckUpdates, unplaceableUpdate, type TurnCheckUpdate } from "./turn-check.js";
import { workReceiptDigestFrom } from "./work-receipt.js";
import {
  readAttestation,
  readChain,
  reuseEvidenceFor,
  signReusedIntent,
  signReusedRecord,
  storeAttestation,
} from "./attestation.js";
import type { Sha256 } from "@thwip/queue-protocol";
import type { SnapshotQueueStore } from "./snapshot-store.js";
import type { QueueCommands } from "./commands.js";
import {
  candidateResultBytes,
  candidateResultDigest,
  decideCandidate,
  requiresIntegratedRun,
} from "./candidate-verdict.js";
import { putEvidence, type R2Like } from "./evidence-store.js";
import type { CandidateSuite } from "./store.js";
import {
  candidateVerdict as readCandidateVerdict,
  claimCandidateDispatch,
  recordCandidateVerdict,
} from "./candidate-store.js";

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
  /** Digest-addressed evidence. Absent in environments that have no bucket. */
  readonly EVIDENCE?: R2Bucket;
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
/**
 * How long a dispatched verifier may stay silent before another is asked for. A
 * run that dies without reporting must not wedge its candidate forever.
 */
const CANDIDATE_DISPATCH_STALE_MS = 15 * 60_000;

function branchRef(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!value.startsWith("refs/heads/") || value.length <= "refs/heads/".length) return null;
  if (value.length > 1024) return null;
  return value;
}

/**
 * Shape a snapshot into the message the projection tables expect.
 *
 * The projection exists so organization-wide reads and exports do not have to load
 * every queue document, and so a check that is only going to be told to wait can be
 * answered from a row read.
 */
export function projectionMessageFrom(
  repositoryId: string,
  baseRef: string,
  snapshot: QueueSnapshot,
): ProjectionMessage {
  return {
    repositoryId,
    baseRef,
    queueEpoch: snapshot.queueEpoch,
    generation: snapshot.generation,
    activeAttemptId: snapshot.activeAttemptId,
    paused: snapshot.paused,
    pauseReason: snapshot.pauseReason,
    rebaselineRequired: snapshot.rebaselineRequired,
    baseSha: snapshot.baseSha,
    entries: snapshot.entries.map((e) => ({
      entryId: e.entryId,
      pullRequestNumber: e.pullRequestNumber,
      sponsorPrincipalId: e.sponsorPrincipalId,
      state: e.state,
      primaryReason: e.primaryReason,
      fairnessOrdinal: e.fairnessOrdinal,
      schedulerEligible: e.schedulerEligible,
      cooldownUntil: e.cooldownUntil,
      lastAttemptId: e.lastAttemptId,
      headSha: e.headSha,
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

/**
 * Write evidence, reporting what happened rather than throwing.
 *
 * A bucket may be absent, and a storage failure must not lose a verdict the
 * verifier already produced: the queue's decision is authoritative from the
 * object, and the bucket exists so a reader can audit it afterwards.
 */
async function storeEvidence(
  env: QueueRouteEnv,
  input: Parameters<typeof putEvidence>[1],
): Promise<string> {
  if (env.EVIDENCE === undefined) return "no-bucket";
  try {
    const result = await putEvidence(env.EVIDENCE as unknown as R2Like, input);
    if (result.stored) return result.deduplicated ? "already-stored" : "stored";
    return result.reason;
  } catch (error) {
    return `failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`;
  }
}

/**
 * Ask GitHub to drive whichever pull request currently holds or has been offered
 * the lane.
 *
 * Merging used to depend on a check being in flight at the instant the queue
 * offered a turn. Every other offer expired ninety seconds later unclaimed, so
 * the queue cycled offers nobody could take and nothing merged. A queue has to
 * cause the work, not wait to be noticed.
 *
 * Safe to call whenever the lane moves: the workflow asks the queue for
 * authorization itself and does nothing if the answer is no.
 */
/**
 * Build, sign, store and record the transition for a merge that landed.
 *
 * The chain link is the digest of the record, so the record has to exist before
 * the link can. Where it cannot be built the link is not written: a missing link
 * is visible and can be retried, while a link naming a record nobody has is the
 * thing this replaces.
 */
async function recordMergedTransition<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: {
    activePolicy(
      env: TEnv,
      repositoryId: string,
    ): Promise<{
      policyDigest: string;
      pipelineDigest: string | null;
      requiredSuites: readonly string[];
    } | null>;
    proofCheckRunId(env: TEnv, repositoryId: string, headSha: string): Promise<string | null>;
  /**
   * Publish the candidate verdict as a check on the pull request head.
   *
   * The verifier workflow used to do this and was refused the permission, so a
   * passing verification finished as a failed run. Optional, because failing to
   * publish must never cost a verdict that has already been recorded.
   */
  publishCandidateCheck?(
    env: TEnv,
    repositoryId: string,
    update: { headSha: string; accepted: boolean; summary: string },
  ): Promise<void>;
    signRecordBytes(env: TEnv, bytes: Uint8Array, typ: string): Promise<string>;
    commitFacts(
      env: TEnv,
      repositoryId: string,
      sha: string,
    ): Promise<{ treeOid: string; parentShas: string[]; message?: string } | null>;
  },
  input: {
    repositoryId: string;
    baseRef: string;
    attemptId: string;
    mergeSha: string;
    mergeTree: string;
    parentShas: readonly string[];
    attempt: {
      baseSha: string | null;
      headSha: string | null;
      receiptDigest: string | null;
      intentDigest: string | null;
      verifierResultDigest: string | null;
    } | null;
    chainHead: { sequence: number; digest: string } | null;
    queueEpoch: number;
    turnSequence: number;
    pullRequestNumber: number | null;
    witnessPrincipalIds: readonly string[];
    onQueue: <T>(
      env: TEnv,
      repositoryId: string,
      baseRef: string,
      decide: (parts: { store: SnapshotQueueStore; commands: QueueCommands }) => T,
    ) => Promise<{ result: T; snapshot: QueueSnapshot }>;
  },
): Promise<{
  status: string;
  sequence: number | null;
  digest: string | null;
  detail?: string;
  snapshot: QueueSnapshot | null;
}> {
  const skip = (detail: string) => ({ status: "skipped", sequence: null, digest: null, detail, snapshot: null });

  const attempt = input.attempt;
  if (attempt?.headSha == null || attempt.baseSha == null || attempt.receiptDigest == null) {
    return skip("the attempt no longer holds what the record would cite");
  }
  if (attempt.intentDigest == null) return skip("no signed merge intent to cite");
  if (input.pullRequestNumber === null) return skip("the merged entry could not be found");

  const evidence = await reuseEvidenceFor(
    attempt.receiptDigest as Sha256,
    await deps.activePolicy(env, input.repositoryId),
    await deps.proofCheckRunId(env, input.repositoryId, attempt.headSha),
    // Present exactly when the queue had the integrated candidate run, which is
    // what decides whether the record claims a verified merge or a reuse.
    attempt.verifierResultDigest,
  );
  if ("missing" in evidence) return skip(evidence.missing);

  // The tree the branch had before this merge. A transition that is not the
  // first in its epoch has to say where it started from, and only the commit
  // itself can say that.
  const before = await deps.commitFacts(env, input.repositoryId, attempt.baseSha);

  const signed = await signReusedRecord({
    attemptId: input.attemptId,
    git: {
      objectFormat: "sha1",
      repositoryId: input.repositoryId,
      baseRef: input.baseRef as `refs/heads/${string}`,
      baseSha: attempt.baseSha,
      headRepositoryId: input.repositoryId,
      headSha: attempt.headSha,
      candidateSha: input.mergeSha,
      candidateTreeOid: input.mergeTree,
      candidateParentOids: [...input.parentShas],
    },
    position: {
      queueEpoch: input.queueEpoch,
      turnSequence: input.turnSequence,
      transitionSequence: (input.chainHead?.sequence ?? 0) + 1,
      previousTransitionDigest: (input.chainHead?.digest ?? null) as Sha256 | null,
    },
    pullRequestNumber: input.pullRequestNumber,
    evidence,
    mergeIntentDigest: attempt.intentDigest as Sha256,
    before: { baseSha: attempt.baseSha, treeOid: before?.treeOid ?? null },
    final: { sha: input.mergeSha, treeOid: input.mergeTree, parentShas: input.parentShas },
    observedAt: new Date().toISOString(),
    signer: { sign: (bytes, typ) => deps.signRecordBytes(env, bytes, typ) },
  });
  if ("error" in signed) return skip(`the queue refused to sign its own record: ${signed.error}`);

  // Stored before the link is written, so a link never names a record that
  // cannot be read back.
  await storeAttestation(env.DB as unknown as D1Like, {
    digest: signed.digest,
    kind: evidence.verifierResultDigest === undefined ? "reused-proof-merge" : "candidate-verified-merge",
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    transitionSequence: (input.chainHead?.sequence ?? 0) + 1,
    attemptId: input.attemptId,
    bytes: signed.bytes,
    jws: signed.jws,
  });

  const { result, snapshot } = await input.onQueue(env, input.repositoryId, input.baseRef, ({ commands, store }) =>
    recordOnly(commands, store, {
      attemptId: input.attemptId,
      kind: evidence.verifierResultDigest === undefined ? "reused" : "verified",
      digest: signed.digest,
      baseSha: input.mergeSha,
      witnessPrincipalIds: input.witnessPrincipalIds,
    }),
  );
  return { status: result.transition.status, sequence: result.sequence, digest: signed.digest, snapshot };
}

async function driveLane(
  env: QueueRouteEnv,
  deps: { driveTurn(env: QueueRouteEnv, repositoryId: string, pullRequestNumber: number): Promise<void> },
  repositoryId: string,
  snapshot: QueueSnapshot,
): Promise<void> {
  const holder = snapshot.entries.find((e) => e.state === "Offered" || e.state === "Active");
  if (holder === undefined) return;
  try {
    await deps.driveTurn(env, repositoryId, holder.pullRequestNumber);
  } catch {
    /* the turn survives; a later tick or the drain asks again */
  }
}

/**
 * Run commands against the queue and mirror the result into the projection.
 *
 * Every mutating route goes through here, which is what keeps a single answer to
 * "who holds the lane". The compare-and-swap inside makes concurrent routes
 * safe; the projection write afterwards is what the dashboard and the fast
 * decline path read, and a stale one only ever costs a pull request a round.
 */
export async function runOnQueue<T>(
  env: QueueRouteEnv,
  repositoryId: string,
  baseRef: string,
  decide: (parts: { store: SnapshotQueueStore; commands: QueueCommands }) => T,
  publish?: (update: TurnCheckUpdate) => Promise<void>,
): Promise<{ result: T; snapshot: QueueSnapshot }> {
  const db = env.DB as unknown as D1Like;
  let before: QueueSnapshot | null = null;
  const out = await withQueueState(db, repositoryId, baseRef, (store) => {
    // Read before the commands run, so what changed can be worked out afterwards
    // rather than guessed at. Re-read on every retry, because the state this
    // attempt started from is the only honest baseline for what it changed.
    before = buildSnapshot(store);
    const commands = commandsFor(store);
    // Whatever is already due, before anything else.
    //
    // A Durable Object has an alarm; D1 does not. Without this, an offer nobody
    // claimed never expires, and an offer that never expires holds the lane
    // forever. This is what the alarm did, minus the waking up: the queue is
    // touched on every authorization, every webhook and every nudge, and the
    // document is loaded already, so catching up costs nothing.
    commands.runAlarm();
    const result = decide({ store, commands });

    // If whatever just happened left the lane free, offer it before answering.
    //
    // Freeing the lane and offering it were separate, so a command that ended a
    // turn — a cancel, a merge, an expiry — left the queue idle with pull
    // requests waiting until something external happened to poke it. That is how
    // a repository sat with a free lane and four ready entries and merged
    // nothing. A queue should cause the next turn, not wait to be asked for it.
    //
    // Cheap to do unconditionally: the scheduler refuses while a lane is busy or
    // the queue is paused, and a tick that offers nothing writes no event.
    if (store.state().activeAttemptId === null) {
      commands.tick({
        idempotencyKey: `settle:${store.generation()}`,
        decisionDigest: `sha256:${"0".repeat(64)}`,
      });
    }
    return { result, snapshot: buildSnapshot(store) };
  });
  try {
    await projectQueueState(db, projectionMessageFrom(repositoryId, baseRef, out.snapshot));
  } catch {
    /* the projection may lag; the command already succeeded */
  }

  // After the write, never inside it. Publishing is a call to GitHub, and holding
  // a compare-and-swap open across the network is how a queue starts losing races
  // it should have won. Failing to publish is survivable: the check stays as it
  // was and the next command that moves the lane publishes again.
  if (publish !== undefined) {
    for (const update of turnCheckUpdates(before, out.snapshot)) {
      try {
        await publish(update);
      } catch {
        /* the check may lag; the queue has already decided */
      }
    }
  }
  return out;
}

/** Read the queue without writing anything. */
async function readQueue(
  env: QueueRouteEnv,
  repositoryId: string,
  baseRef: string,
): Promise<{ store: SnapshotQueueStore; snapshot: QueueSnapshot }> {
  const loaded = await loadQueueState(env.DB as unknown as D1Like, repositoryId, baseRef);
  return { store: loaded.store, snapshot: buildSnapshot(loaded.store) };
}

/**
 * Turn a thrown error into something a caller can act on.
 *
 * Every one of these used to surface as "Internal Server Error", and diagnosing a
 * single storage constraint failure cost several round trips through a worker tail.
 * The message is safe to return: it names an invariant or a table, never user data.
 */
function failure(error: unknown): {
  code: string;
  /** Shown to the caller. Written by us, never taken from the thrown error. */
  message: string;
  /** Logged, never returned. */
  detail: string;
  status: 409 | 429 | 500;
} {
  const detail = error instanceof Error ? error.message : String(error);
  if (/invariant violation/i.test(detail)) {
    return {
      code: "QUEUE_INVARIANT_VIOLATION",
      message: "The queue refused this because it would break one of its own rules.",
      detail,
      status: 409,
    };
  }
  if (/UNIQUE constraint|SQLITE_CONSTRAINT/i.test(detail)) {
    return {
      code: "QUEUE_STORAGE_CONFLICT",
      message: "Something else changed this queue at the same moment. Try again.",
      detail,
      status: 409,
    };
  }
  if (/has not been bound|queue key does not match/i.test(detail)) {
    return {
      code: "QUEUE_NOT_BOUND",
      message: "No queue is configured for this repository and branch.",
      detail,
      status: 409,
    };
  }
  // What the provider says about capacity is about us. Naming Durable Objects and
  // a free tier in a customer's dashboard tells them about our bill and gives them
  // nothing they can act on.
  if (/exceeded|rate limit|too many|overloaded|quota/i.test(detail)) {
    return {
      code: "QUEUE_TEMPORARILY_UNAVAILABLE",
      message: "The queue is temporarily unavailable. Nothing has been lost; this view will catch up.",
      detail,
      status: 429,
    };
  }
  return {
    code: "QUEUE_COMMAND_FAILED",
    message: "The queue could not complete that. Nothing was changed.",
    detail,
    status: 500,
  };
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
    /**
     * The pipeline the proof had to satisfy, which a reuse record binds. Null
     * when the bundle names none; a record then cannot be built rather than
     * being built around a substitute.
     */
    pipelineDigest: string | null;
    requiredSuites: readonly string[];
    securityProfile: string;
    /** Evidence keys are tenant-scoped so an export or deletion can be bounded. */
    organizationId: string;
    /** Null when no verifier is pinned, which only matters to a stronger profile. */
    verifier: { workflowRef: string; workflowSha: string | null } | null;
  } | null>;
  /**
   * Ask the pinned verifier to run the required suites against a candidate.
   *
   * Returns what GitHub said. A dispatch that fails silently leaves the caller
   * waiting for a run that will never start, and the first version of this
   * discarded the response — so a missing App permission looked exactly like a
   * slow verifier for thirty minutes.
   */
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
  ): Promise<{ ok: true } | { ok: false; status: number; detail: string }>;
  /** Queue configuration for a branch, or null when the branch has no queue. */
  queueProject(env: TEnv, repositoryId: string, baseRef: string): Promise<{ activationState: string } | null>;
  /** The activated principal for a GitHub user id, or null. */
  principalFor(env: TEnv, githubUserId: string): Promise<string | null>;
  /** Ask GitHub to run the merge workflow for a pull request the queue has offered. */
  driveTurn(env: TEnv, repositoryId: string, pullRequestNumber: number): Promise<void>;
  /**
   * Publish whose turn it is, as a check GitHub can require.
   *
   * Separate from the proof check because the two answers change on different
   * clocks, and because a required check that goes red for merely waiting keeps
   * refusing the merge after the queue has said yes.
   */
  publishTurnCheck?(env: TEnv, repositoryId: string, update: TurnCheckUpdate): Promise<void>;
  /** Read a commit's tree and parents from GitHub, for confirming from facts. */
  commitFacts(
    env: TEnv,
    repositoryId: string,
    sha: string,
  ): Promise<{ treeOid: string; parentShas: string[]; message?: string } | null>;
  /**
   * The App's proof check that verified a head, by its run id.
   *
   * A reuse merge rests on that check having passed, so the record cites it. Null
   * when no accepted verification exists for the head, which is a reason to
   * record nothing rather than to cite a check that never ran.
   */
  proofCheckRunId(env: TEnv, repositoryId: string, headSha: string): Promise<string | null>;
  /**
   * Publish the candidate verdict as a check on the pull request head.
   *
   * The verifier workflow used to do this and was refused the permission, so a
   * passing verification finished as a failed run. Optional, because failing to
   * publish must never cost a verdict that has already been recorded.
   */
  publishCandidateCheck?(
    env: TEnv,
    repositoryId: string,
    update: { headSha: string; accepted: boolean; summary: string },
  ): Promise<void>;
  /**
   * Sign canonical record bytes with the service key, returning a compact JWS.
   *
   * Takes bytes rather than a value so the signature covers exactly what the
   * digest names; re-serialising here would sign something else that happens to
   * mean the same.
   */
  signRecordBytes(env: TEnv, bytes: Uint8Array, typ: string): Promise<string>;
}) {
  const app = new Hono<{ Bindings: TEnv }>();

  /**
   * Every mutating route, with the turn check wired in.
   *
   * Bound here rather than passed at each call site so no route can quietly skip
   * publishing: the lane moving without the check following it is the failure
   * that made the queue rotate turns nobody could take.
   */
  const onQueue = <T,>(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
    decide: (parts: { store: SnapshotQueueStore; commands: QueueCommands }) => T,
  ) =>
    runOnQueue(env, repositoryId, baseRef, decide, (update) =>
      deps.publishTurnCheck === undefined
        ? Promise.resolve()
        : deps.publishTurnCheck(env, repositoryId, update),
    );

  // One place where a thrown error becomes a named one.
  app.onError((error, c) => {
    const { code, message, detail, status } = failure(error);
    console.error(`queue ${code}: ${detail}`);
    return c.json({ error: message, code }, status);
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

    const { store } = await readQueue(c.env, repositoryId, baseRef);
    const report = diagnose(store, Number(c.req.query("events") ?? 25));

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

    // Served from the projection, not the object.
    //
    // The dashboard polls this, once per project, on a timer. Answering from the
    // Durable Object meant two RPCs per project per poll, and a single open
    // browser tab was enough to spend the Durable Objects free tier for a month.
    // The projection exists precisely so a read never has to wake the object.
    //
    // `?live=1` still reads the object, for the cases where being a few seconds
    // stale is the wrong answer: an operator checking after a manual repair.
    if (c.req.query("live") === "1") {
      const { snapshot } = await readQueue(c.env, repositoryId, baseRef);
      return c.json({ ...snapshot, source: "queue" });
    }
    const projected = await readProjectedQueue(c.env.DB as unknown as D1Like, repositoryId, baseRef);
    if (projected !== null) return c.json(projected);

    // Nothing projected yet, which is not the same as no queue. Read the
    // authoritative document and fill the projection from it, so a migration that
    // reset the marks does not leave every read doing this forever.
    const { snapshot } = await readQueue(c.env, repositoryId, baseRef);
    try {
      await projectQueueState(
        c.env.DB as unknown as D1Like,
        projectionMessageFrom(repositoryId, baseRef, snapshot),
      );
    } catch {
      /* the projection may lag; the read already has its answer */
    }
    return c.json({ ...snapshot, source: "queue" });
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

    const entryId = `entry_${repositoryId}_${body.pullRequestNumber}`;
    const headSha = body.headSha;
    const pullRequestNumber = body.pullRequestNumber;
    const { result } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) =>
      commands.requestQueue({
        idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `request:${entryId}`),
        entryId,
        pullRequestNumber,
        sponsorPrincipalId,
        sponsorGithubUserId,
        headSha,
      }),
    );
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
    const entryId = c.req.param("entryId");
    const { result } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) =>
      commands.cancel({
        idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `cancel:${entryId}`),
        entryId,
        actorPrincipalId: who.principalId,
        reason,
      }),
    );
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

    const key = idempotencyKey(c.req.header("idempotency-key"), `tick:${crypto.randomUUID()}`);
    const { result, snapshot } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) =>
      commands.tick({
        idempotencyKey: key,
        decisionDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    );
    await driveLane(c.env, deps, repositoryId, snapshot);
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
    const reason = body.reason;
    const { result } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) =>
      commands.pause({
        idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `pause:${crypto.randomUUID()}`),
        actorPrincipalId: who.principalId,
        reason,
      }),
    );
    return c.json({ result });
  });

  app.post("/v1/queue/:repositoryId/resume", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);
    if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

    // A refusal here means a rebaseline is still required after external movement.
    const { result } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) =>
      commands.resume({
        idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `resume:${crypto.randomUUID()}`),
        actorPrincipalId: who.principalId,
      }),
    );
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
    const baseSha = body.baseSha;
    const { result } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) =>
      commands.rebaseline({
        idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `rebaseline:${baseSha}`),
        actorPrincipalId: who.principalId,
        baseSha,
      }),
    );
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

    const verdict = {
      idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `verdict:${body.attemptId}:${identity.jti}`),
      attemptId: body.attemptId,
      nonce: body.nonce,
      accepted: body.accepted,
      resultDigest: body.resultDigest,
    };
    const attemptRevision = body.attemptRevision;

    // Classified and applied in the same transaction. Split across two, the
    // attempt can move in between and the verdict lands against a revision that
    // was current when it was checked and is not when it is written.
    const { result } = await onQueue(c.env, repositoryId, baseRef, ({ store, commands }) => {
      // A result for an older attempt is stale and harmless; one for the current
      // attempt at a stale revision is a conflict and must not be applied.
      if (typeof attemptRevision === "number") {
        const standing = store.classifyCallback(verdict.attemptId, attemptRevision);
        if (standing !== "current") return { stale: standing } as const;
      }
      return { applied: commands.completeVerification(verdict) } as const;
    });
    if ("stale" in result) return c.json({ error: result.stale, code: result.stale }, 409);
    return c.json({ result: result.applied }, result.applied.status === "rejected" ? 409 : 202);
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
      // The revision this run actually came from. The pin may name no revision, and
      // recording the pin instead of the run would erase what was really executed.
      workflowSha: identity.workflowSha,
      runId: identity.runId,
    };
    const resultDigest = await candidateResultDigest(content);

    // D1, not the object. A verdict is an immutable record about a tree; waking
    // the coordination object to store or read one is what made the merge
    // workflow's wait cost a Durable Object request every twenty seconds.
    const stored = await recordCandidateVerdict(c.env.DB as unknown as D1Like, repositoryId, baseRef, {
      ...content,
      resultDigest,
      observedAt: new Date().toISOString(),
    });

    // Persist the bytes the digest was taken over, so the digest the transition
    // chain records resolves to something a reader can fetch and check. Without
    // this the chain holds a hash of evidence nobody outside the object can see.
    const evidence = await storeEvidence(c.env, {
      organizationId: policy.organizationId,
      repositoryId,
      kind: "verifier-result",
      digest: resultDigest as `sha256:${string}`,
      bytes: candidateResultBytes(content),
    });

    // Say so on the pull request. The verifier workflow cannot: it asks GitHub
    // for `checks: write` and is refused, so it finished red on every passing
    // verification. Only on the first recording, and never at the cost of the
    // verdict itself, which is already stored by this point.
    if (stored.status === "applied" && deps.publishCandidateCheck !== undefined) {
      const { snapshot } = await readQueue(c.env, repositoryId, baseRef);
      const head = snapshot.entries.find((e) => e.pullRequestNumber === body.pullRequestNumber)?.headSha;
      if (head != null) {
        const lines = suites
          .map((s) => `- \`${s.name}\`: ${s.outcome} in ${Math.round(s.durationMs / 100) / 10}s`)
          .join("\n");
        try {
          await deps.publishCandidateCheck(c.env, repositoryId, {
            headSha: head,
            accepted: body.accepted === true,
            summary: `Ran against merge tree \`${candidateTreeOid}\`, not the pull request head.\n\n${lines}`,
          });
        } catch {
          /* the verdict stands; the check is how it is shown, not what it is */
        }
      }
    }

    // Call the merge back. This is the other half of not polling: the verdict
    // has landed, the queue knows whose turn it is, so it tells that pull request
    // rather than leaving it to ask. Only on acceptance, and only when this is the
    // first time we have recorded it, so a retried report does not re-drive.
    if (body.accepted === true && stored.status === "applied") {
      try {
        await deps.driveTurn(c.env, repositoryId, body.pullRequestNumber);
      } catch {
        /* the turn survives; the drain re-drives it if this was the only chance */
      }
    }

    return c.json({ recorded: stored.status, resultDigest, candidateTreeOid, evidence }, 202);
  });

  /**
   * Has this candidate been verified yet?
   *
   * The merge workflow waits here rather than on the authorization endpoint. It
   * used to poll authorization every twenty seconds, and each poll woke the
   * Durable Object, which is the one resource with a hard daily cap. This reads a
   * single D1 row and touches no object at all, so waiting is free and the object
   * is only involved when there is something to decide.
   */
  app.get("/v1/queue/:repositoryId/candidate", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    const tree = c.req.query("tree");
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);
    if (typeof tree !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) {
      return c.json({ error: "tree must be a lowercase hex object id" }, 400);
    }
    // Either identity. The merge workflow polls this with an Actions OIDC token,
    // the same one it authorizes with; a person or the CLI arrives with a session
    // or an operator token. Accepting only the latter meant the workflow got a 401
    // on every poll, never saw its verdict, and spun until its deadline while the
    // verdict sat here accepted.
    const claims = await deps.verifyOidc(c, c.env);
    const fromWorkflow = claims !== null && String(claims["repository_id"] ?? "") === repositoryId;
    if (!fromWorkflow) {
      const who = await deps.authenticate(c, c.env);
      if (!who.ok) return c.json({ error: "unauthorized" }, who.status);
    }

    const verdict = await readCandidateVerdict(c.env.DB as unknown as D1Like, repositoryId, baseRef, tree);
    if (verdict === null) return c.json({ verified: false, candidateTreeOid: tree });
    return c.json({
      verified: true,
      accepted: verdict.accepted,
      candidateTreeOid: tree,
      resultDigest: verdict.resultDigest,
      reasonCodes: verdict.reasonCodes,
      suites: verdict.suites,
      observedAt: verdict.observedAt,
    });
  });

  /**
   * Push whoever currently holds the lane, reading only the projection.
   *
   * A turn offered by the object's alarm cannot be pushed from inside the object:
   * it has no installation token and no way to reach GitHub. So the lane sat idle
   * until some unrelated request happened to move it.
   *
   * This closes that from the outside, and costs nothing to call: it reads D1 and
   * wakes no object. The drain calls it on a schedule, so a lane offered by an
   * alarm is picked up within the half hour even if nothing else happens at all.
   */
  app.post("/v1/queue/:repositoryId/nudge", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    // From the queue, not the projection.
    //
    // This picked whose turn to drive out of a read model that lags, so it could
    // dispatch for a pull request whose turn had already ended. Harmless, because
    // the merge workflow asks the queue itself and does nothing if the answer is
    // no — but it is a wasted run and the same habit that wedged the lane once
    // already. Reading the queue costs one row.
    const { snapshot } = await readQueue(c.env, repositoryId, baseRef);
    const holder = snapshot.entries.find((e) => e.state === "Offered" || e.state === "Active");
    if (holder === undefined) return c.json({ nudged: false, reason: "LANE_IDLE" });

    try {
      await deps.driveTurn(c.env, repositoryId, holder.pullRequestNumber);
    } catch {
      return c.json({ nudged: false, reason: "DISPATCH_FAILED", pullRequestNumber: holder.pullRequestNumber });
    }
    return c.json({ nudged: true, pullRequestNumber: holder.pullRequestNumber, state: holder.state });
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
    const entryId = `entry_${repositoryId}_${body.pullRequestNumber}`;

    // The queue has nobody to give the turn to, so say so on the check.
    //
    // Without an activated principal there is no entry, so nothing moves and the
    // turn check is never published. That is survivable while the check is
    // advisory and a wedge once it is required: a required check that never
    // arrives blocks the merge forever with nothing on the page explaining why.
    // This one is a failure rather than a wait, because it will not resolve on
    // its own.
    //
    // Said on every ask rather than on a change, because there is no entry to
    // compare against. The publisher reads what the commit already says and stays
    // quiet when it is the same, so this does not accumulate.
    if (principalId === null && deps.publishTurnCheck !== undefined) {
      try {
        await deps.publishTurnCheck(
          c.env,
          repositoryId,
          unplaceableUpdate({ entryId, pullRequestNumber: body.pullRequestNumber, headSha: body.headSha }),
        );
      } catch {
        /* the check may lag; the answer below is unaffected */
      }
    }

    // Answered from the queue itself, never from the projection.
    //
    // There used to be a fast path here that declined from the projection so a
    // waiting pull request never woke the Durable Object, because a Durable Object
    // request was the expensive thing. The authority is a D1 row now, and reading
    // it costs one row read against a budget this account uses two percent of, so
    // the fast path was reading more rows than the thing it was avoiding.
    //
    // It was also wrong in a way its own reasoning missed. A stale decline was
    // supposed to be safe because it only costs a pull request one more round. But
    // this endpoint is a required check, and a declined check goes red and stays
    // red. GitHub then refuses the merge on the red check even after the queue has
    // authorized it, and the queue re-offers the same turn to a pull request that
    // can never take it. That is not one more round; that is the lane wedged on a
    // pull request that holds it. It happened, to pull request 59, while the
    // projection was a few hundred milliseconds behind.
    //
    // Writes are what a waiting pull request should avoid, and it still does: the
    // compare-and-swap does not write when the commands changed nothing.
    const db = c.env.DB as unknown as D1Like;

    // Captured after validation: TypeScript discards the narrowing inside a
    // closure, and re-checking would be checking the same thing twice.
    const pullRequestNumber = body.pullRequestNumber;
    const headSha = body.headSha;

    // Enqueue, evaluate readiness, tick the scheduler and claim the offer, all
    // against the stored document. This was a Durable Object round trip, which
    // is the one resource with a daily cliff; it is now a row read and, only when
    // something actually changed, a row write.
    const { snapshot: held } = await onQueue(c.env, repositoryId, baseRef, ({ store, commands }) =>
      principalId === null
        ? buildSnapshot(store)
        : admit(commands, store, {
            entryId,
            pullRequestNumber,
            sponsorPrincipalId: principalId,
            sponsorGithubUserId: String(body.authorGithubUserId),
            headSha,
            ready: body.proofAccepted === true && body.draft !== true,
            schedulerEligible: body.proofAccepted === true && body.draft !== true,
            primaryReason:
              body.draft === true ? "PR_DRAFT" : body.proofAccepted === true ? null : "LOCAL_RECEIPT_MISSING",
            // Time buckets, so a retried check re-evaluates rather than being
            // deduplicated against a decision taken minutes ago, while a burst of
            // parallel jobs for one head still collapses to one turn.
            readinessBucket: Math.floor(Date.now() / 60_000),
            tickBucket: Math.floor(Date.now() / 60_000),
            decisionDigest: `sha256:${"0".repeat(64)}`,
          }),
    );

    let operationId: string | null = null;
    let latest = held;
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
      // No active policy means no stronger claim is being made, so the head proof
      // stands, as it did before candidate verification existed.
      const needsIntegratedRun = policy !== null && requiresIntegratedRun(policy.securityProfile);
      // Null unless something actually ran. Under reuse nothing does, and the
      // constant that used to sit here was stored on the attempt as though a
      // verifier had spoken.
      let verifiedResultDigest: string | null = null;
      let candidatePolicyDigest = policy?.policyDigest ?? `sha256:${"0".repeat(64)}`;

      if (needsIntegratedRun && policy !== null) {
        if (policy.verifier === null || policy.requiredSuites.length === 0) {
          return c.json({
            authorized: false,
            enforcing: true,
            activationState: project.activationState,
            reason: "NO_PINNED_VERIFIER",
            detail:
              "this profile claims the integrated candidate was run, and no pinned verifier or required suite can establish that",
            entryId,
            operationId: null,
          });
        }
        const stored = await readCandidateVerdict(
          c.env.DB as unknown as D1Like,
          repositoryId,
          baseRef,
          cand.candidateTreeOid,
        );
        const decision = await decideCandidate(stored, {
          candidateTreeOid: cand.candidateTreeOid,
          candidateSha: cand.candidateSha,
          baseSha: cand.baseSha,
          requiredSuites: policy.requiredSuites,
          policyDigest: policy.policyDigest,
          workflowRef: policy.verifier.workflowRef,
          workflowSha: policy.verifier.workflowSha,
        });

        if (!decision.ok) {
          // Nothing has run this candidate yet: ask the pinned verifier to, and tell
          // the caller to come back. The caller waits rather than failing, because
          // an untested candidate is a normal early state, not a refusal.
          if (decision.code === "CANDIDATE_NOT_VERIFIED") {
            // Only the first asker dispatches. The caller polls this endpoint while
            // it waits, and dispatching on every poll once cost one candidate four
            // full CI runs.
            const mine = await claimCandidateDispatch(
              c.env.DB as unknown as D1Like,
              repositoryId,
              baseRef,
              cand.candidateTreeOid,
              new Date().toISOString(),
              CANDIDATE_DISPATCH_STALE_MS,
            );
            const dispatched = mine
              ? await deps.dispatchCandidateVerification(c.env, repositoryId, {
                  baseRef,
                  pullRequestNumber: body.pullRequestNumber,
                  attemptId,
                  baseSha: cand.baseSha,
                  candidateSha: cand.candidateSha,
                  candidateTreeOid: cand.candidateTreeOid,
                })
              : ({ ok: true } as const);
            if (!dispatched.ok) {
              // Nothing will arrive, so waiting is the wrong answer. Say what
              // GitHub refused so it can be fixed rather than waited out.
              return c.json({
                authorized: false,
                enforcing: true,
                activationState: project.activationState,
                reason: "CANDIDATE_DISPATCH_FAILED",
                detail: `GitHub refused the verifier dispatch (${dispatched.status}): ${dispatched.detail}`,
                entryId,
                operationId: null,
              });
            }
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
        // The proof the developer signed, by its own digest.
        //
        // This was `sha256:2222…2222`, a constant, so everything downstream that
        // cited a work receipt cited nothing. The proof is on the head commit and
        // the required check has already verified it, so the evidence exists; it
        // was never carried this far.
        //
        // No digest means no receipt, and the merge stops. Falling back to a
        // placeholder is how an empty claim ends up inside a record that reads as
        // evidence, and this is the path that record is built from.
        const head = await deps.commitFacts(c.env, repositoryId, headSha);
        const workReceiptDigest =
          head?.message === undefined ? null : await workReceiptDigestFrom(head.message);
        if (workReceiptDigest === null) {
          return c.json({
            authorized: false,
            enforcing: true,
            activationState: project.activationState,
            reason: "WORK_RECEIPT_UNREADABLE",
            detail:
              "the head commit carries no readable thwip proof, so there is nothing for the merge record to cite",
            entryId,
            operationId: null,
          });
        }

        // Hoisted out of the closure: narrowing a property survives a const
        // binding but not a function boundary.
        const baseSha = cand.baseSha;
        const candidateSha = cand.candidateSha;
        const candidateTree = cand.candidateTreeOid;

        // The merge intent, signed before the merge is asked for.
        //
        // This was `sha256:4444…4444`. The queue recorded that an intent existed
        // and never made one, so nothing said what it was about to do or on what
        // basis. Under this profile the basis is the proof on the head, the
        // policy and pipeline it satisfied, and the check that verified it —
        // every one of which is a real value or the merge does not proceed.
        const reuse = await reuseEvidenceFor(
          workReceiptDigest,
          policy,
          await deps.proofCheckRunId(c.env, repositoryId, headSha),
          verifiedResultDigest,
        );
        if ("missing" in reuse) {
          return c.json({
            authorized: false,
            enforcing: true,
            activationState: project.activationState,
            reason: "MERGE_EVIDENCE_INCOMPLETE",
            detail: `nothing may be signed for this merge: ${reuse.missing}`,
            entryId,
            operationId: null,
          });
        }

        const mergeOperationId = `merge_${attemptId}`;
        const signedIntent = await signReusedIntent({
          operationId: mergeOperationId,
          attemptId,
          git: {
            objectFormat: "sha1",
            repositoryId,
            baseRef: baseRef as `refs/heads/${string}`,
            baseSha,
            headRepositoryId: repositoryId,
            headSha,
            candidateSha,
            candidateTreeOid: candidateTree,
            candidateParentOids: [baseSha, headSha],
          },
          position: {
            queueEpoch: held.queueEpoch,
            turnSequence: held.turnSequence,
            transitionSequence: (held.chainHead?.sequence ?? 0) + 1,
            previousTransitionDigest: (held.chainHead?.digest ?? null) as Sha256 | null,
          },
          pullRequestNumber: body.pullRequestNumber,
          evidence: reuse,
          createdAt: new Date().toISOString(),
          signer: { sign: (bytes, typ) => deps.signRecordBytes(c.env, bytes, typ) },
        });
        if ("error" in signedIntent) {
          return c.json({
            authorized: false,
            enforcing: true,
            activationState: project.activationState,
            reason: "MERGE_INTENT_INVALID",
            detail: `the queue refused to sign its own merge intent: ${signedIntent.error}`,
            entryId,
            operationId: null,
          });
        }
        await storeAttestation(c.env.DB as unknown as D1Like, {
          digest: signedIntent.digest,
          kind: "merge-intent",
          repositoryId,
          baseRef,
          transitionSequence: null,
          attemptId,
          bytes: signedIntent.bytes,
          jws: signedIntent.jws,
        });

        const { result: walked } = await onQueue(c.env, repositoryId, baseRef, ({ store, commands }) => {
          // Checked again inside the transaction. Consulting the verifier took
          // network time, and the lane can move while that happens; walking an
          // attempt that no longer holds it would prepare a merge for a pull
          // request whose turn had already ended.
          if (store.state().activeAttemptId !== attemptId) {
            return { operationId: null, snapshot: buildSnapshot(store) };
          }
          return walkToMergeReady(commands, store, {
            attemptId,
            baseSha,
            headSha,
            candidateSha,
            candidateTree,
            policyDigest: candidatePolicyDigest,
            runner: needsIntegratedRun ? "verified-candidate" : "reuse",
            // Nothing was dispatched, so there is no assignment to issue. The
            // reducer no longer demands one for an attempt nobody assigned.
            assignmentDigest: null,
            receiptDigest: workReceiptDigest,
            verifierResultDigest: verifiedResultDigest,
            intentDigest: signedIntent.digest,
            operationId: mergeOperationId,
          });
        });
        operationId = walked.operationId;
        latest = walked.snapshot;
      }
    }

    const snapshot = latest;
    const entry = snapshot.entries.find((e) => e.entryId === entryId);

    // A check's authorize moves the lane as much as a tick does: admit enqueues,
    // evaluates, ticks and claims. If that offered the turn to somebody else,
    // nothing was telling them, and the lane sat until an unrelated call happened
    // to notice.
    await driveLane(c.env, deps, repositoryId, snapshot);

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

    // A paused queue authorizes nobody, including whoever already holds the lane.
    //
    // Pause stopped new turns being offered but said nothing about the turn in
    // flight, so an operator pausing because the base had moved outside the queue
    // would still have watched the current holder merge onto a base nobody had
    // checked. Pausing is the thing an operator reaches for when they want
    // merging to stop, so it stops merging.
    const halted = snapshot.paused || snapshot.rebaselineRequired;
    const holdsUsableTurn = holdsLane && !halted;

    // In observe the answer is always yes, and the reason says what it would have
    // been. That is what makes adoption reversible.
    const authorized = enforcing ? holdsUsableTurn : true;
    return c.json({
      authorized,
      enforcing,
      activationState: project.activationState,
      reason: halted
        ? snapshot.rebaselineRequired
          ? "REBASELINE_REQUIRED"
          : "QUEUE_PAUSED"
        : holdsLane
          ? "HOLDS_TURN"
          : (entry?.primaryReason ?? "WAITING_FOR_TURN"),
      entryId,
      operationId,
      queuePosition: snapshot.entries.filter((e) => e.state === "Ready").length,
    });
  });

  /**
   * Carry the recorded transition chain into the queue document.
   *
   * Needed once per queue, when the authority moved from the Durable Object to
   * D1 with the object unreachable. Entries rebuild themselves because every
   * pull request asks the gate again; the chain cannot, and a queue that started
   * a fresh one would record its next merge as the first link ever.
   *
   * Idempotent by refusal: it will not adopt on top of a chain that already has
   * links, and it stops at the first break rather than leaving a hole.
   */
  app.post("/v1/queue/:repositoryId/adopt-chain", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);
    if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

    const chain = await readProjectedChain(c.env.DB as unknown as D1Like, repositoryId, baseRef);
    const { result } = await onQueue(c.env, repositoryId, baseRef, ({ commands, store }) =>
      adoptChain(commands, store, chain),
    );
    return c.json({ ...result, available: chain.length }, result.adopted === 0 && chain.length > 0 ? 409 : 200);
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

    const { snapshot } = await readQueue(c.env, repositoryId, baseRef);
    const attemptId = snapshot.activeAttemptId;
    if (attemptId === null) return c.json({ error: "no attempt holds the lane" }, 409);
    const reason = body.reason.trim();

    if (body.observed === "merged") {
      // Confirmed from the commit itself, never from the operator's word. The
      // reducer then refuses any tree that is not the candidate it authorized, so
      // asserting a merge that did not happen cannot certify anything.
      if (typeof body.mergeSha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(body.mergeSha)) {
        return c.json({ error: "mergeSha required to confirm a merge" }, 400);
      }
      const mergeSha = body.mergeSha;
      const facts = await deps.commitFacts(c.env, repositoryId, mergeSha);
      if (facts === null) return c.json({ error: "could not read that commit" }, 404);

      // Confirmed first, then the signed record, exactly as the merge callback
      // does it. An operator resolving by hand produces the same link as the
      // workflow would have; the digest used to be the merge sha padded out, so
      // reconciliation wrote a link that attested to nothing.
      const { result: confirmation, snapshot: afterConfirm } = await onQueue(
        c.env,
        repositoryId,
        baseRef,
        ({ commands, store }) =>
          confirmOnly(commands, store, {
            attemptId,
            operationId: `merge_${attemptId}`,
            mergeSha,
            mergeTree: facts.treeOid,
            parentShas: facts.parentShas,
          }),
      );
      if (confirmation.confirmed.status === "rejected") {
        return c.json({ error: confirmation.confirmed.detail, code: "RESULT_NOT_AUTHORIZED" }, 409);
      }

      const recorded = await recordMergedTransition(c.env, deps, {
        repositoryId,
        baseRef,
        attemptId,
        mergeSha,
        mergeTree: facts.treeOid,
        parentShas: facts.parentShas,
        attempt: confirmation.attempt,
        chainHead: confirmation.chainHead,
        queueEpoch: afterConfirm.queueEpoch,
        turnSequence: afterConfirm.turnSequence,
        pullRequestNumber:
          afterConfirm.entries.find((e) => e.entryId === confirmation.attempt?.entryId)?.pullRequestNumber ?? null,
        witnessPrincipalIds: [who.principalId],
        onQueue,
      });

      return c.json({
        resolved: confirmation.confirmed.status,
        transition: recorded.status,
        sequence: recorded.sequence,
        transitionDigest: recorded.digest,
        detail: recorded.detail,
        attemptId,
        actor: who.principalId,
        reason,
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
      const mergeSha = body.mergeSha;
      const { result } = await onQueue(c.env, repositoryId, baseRef, ({ commands, store }) => {
        // The entry leaves the queue with the attempt. Terminating the attempt
        // alone left the entry Blocked and still scheduler-eligible, so the queue
        // went on holding a merged pull request as live work and could have
        // offered it a lane. Cancelled rather than Merged: the queue did not merge
        // this and must not claim it did.
        const entryId = buildSnapshot(store).activeEntryId;
        if (entryId !== null) {
          commands.cancel({
            idempotencyKey: `outside:cancel:${attemptId}`,
            entryId,
            actorPrincipalId: who.principalId,
            reason,
          });
        } else {
          commands.terminateAttempt({
            idempotencyKey: `outside:${attemptId}`,
            attemptId,
            outcome: "ADMIN_CANCELLED",
          });
        }
        const head = store.state().transitions.at(-1);
        const sequence = (head?.transitionSequence ?? 0) + 1;
        const transition = commands.recordTransition({
          idempotencyKey: `outside:transition:${attemptId}`,
          kind: "external",
          transitionSequence: sequence,
          priorDigest: head?.digest ?? null,
          digest: `sha256:${mergeSha.padEnd(64, "0").slice(0, 64)}`,
          baseSha: mergeSha,
          attemptId: null,
          witnessPrincipalIds: [],
        });
        return { entryId, sequence, transition };
      });
      return c.json({
        resolved: "external",
        transition: result.transition.status,
        sequence: result.sequence,
        attemptId,
        entryResolved: result.entryId === null ? "no entry held the lane" : "cancelled",
        note: "recorded as external: the queue held a turn but never pinned a candidate for this merge",
      });
    }

    if (body.observed !== "not-merged") {
      return c.json({ error: 'observed must be "merged", "not-merged", or "merged-outside-the-turn"' }, 400);
    }

    const { result: resolved } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) =>
      commands.confirmNotMerged({
        idempotencyKey: `reconcile:${attemptId}:${reason.slice(0, 32)}`,
        attemptId,
        operationId: `merge_${attemptId}`,
      }),
    );
    return c.json({
      resolved: resolved.status,
      attemptId,
      actor: who.principalId,
      reason,
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

    const attemptId = body.attemptId;
    const operationId = body.operationId;
    const { result: resolved } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) => {
      // An outcome already in doubt has to be declared unknown before it can be
      // resolved, which is the reducer refusing to skip reconciliation.
      commands.mergeOutcomeUnknown({
        idempotencyKey: `not-merged:unknown:${attemptId}`,
        attemptId,
      });
      return commands.confirmNotMerged({
        idempotencyKey: `not-merged:${attemptId}`,
        attemptId,
        operationId,
      });
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

    const attemptId = body.attemptId!;
    const mergeSha = body.mergeSha!;

    // Confirm first. The record that becomes the chain link binds the tree that
    // actually landed, so it cannot be built until the queue has accepted that
    // this is the tree it authorized.
    const { result: confirmation, snapshot: afterConfirm } = await onQueue(
      c.env,
      repositoryId,
      baseRef,
      ({ commands, store }) =>
        confirmOnly(commands, store, {
          attemptId,
          operationId: body.operationId!,
          mergeSha,
          mergeTree: body.mergeTree!,
          parentShas: body.parentShas ?? [],
        }),
    );

    if (confirmation.confirmed.status === "rejected") {
      // The reducer refuses a tree that is not the candidate it authorized, so a
      // rejection here means something other than the verified integration landed.
      return c.json({ error: confirmation.confirmed.detail, code: "RESULT_NOT_AUTHORIZED" }, 409);
    }

    // The transition record, signed, and its digest is the link. This was the
    // merge commit id padded out to sixty-four characters — a value shaped like a
    // digest that was the digest of nothing, so the chain recorded that merges
    // happened and attested to none of them.
    const recorded = await recordMergedTransition(c.env, deps, {
      repositoryId,
      baseRef,
      attemptId,
      mergeSha,
      mergeTree: body.mergeTree!,
      parentShas: body.parentShas ?? [],
      attempt: confirmation.attempt,
      chainHead: confirmation.chainHead,
      queueEpoch: afterConfirm.queueEpoch,
      turnSequence: afterConfirm.turnSequence,
      pullRequestNumber:
        afterConfirm.entries.find((e) => e.entryId === confirmation.attempt?.entryId)?.pullRequestNumber ?? null,
      witnessPrincipalIds: body.sponsorPrincipalId === undefined ? [] : [body.sponsorPrincipalId],
      onQueue,
    });

    await driveLane(c.env, deps, repositoryId, recorded.snapshot ?? afterConfirm);
    return c.json({
      merged: true,
      confirmed: confirmation.confirmed.status,
      transition: recorded.status,
      sequence: recorded.sequence,
      transitionDigest: recorded.digest,
      // Said plainly when a link could not be built, because a chain short by one
      // is something an operator has to be able to see.
      detail: recorded.detail,
    });
  });

  /**
   * A signed record, by the digest that names it.
   *
   * The chain reports digests; this is what makes them checkable. Without it a
   * reader can see that a link exists and has no way to see what it says, which
   * is the position the queue was in when a link was a padded commit id.
   *
   * Open, like the chain it belongs to: a record names commits, digests and a
   * check run, all of which are visible to anyone who can see the repository.
   */
  app.get("/v1/queue/records/:digest", async (c) => {
    const digest = c.req.param("digest");
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return c.json({ error: "not a digest" }, 400);
    const found = await readAttestation(c.env.DB as unknown as D1Like, digest);
    if (found === null) return c.json({ error: "no record with that digest" }, 404);
    return c.json(found);
  });

  /**
   * A branch's whole chain, with the bytes each link was signed over.
   *
   * Open only when the project has said so. A chain names pull request
   * numbers, head and base SHAs, tree oids, actor GitHub ids and free-text
   * override reasons — public for a public repository, and nobody else's
   * business for a private one. A caller cannot make it public just by
   * knowing the numeric repository id, so a private project is served the
   * same way every other authenticated queue route is: the caller has to be
   * a member.
   */
  app.get("/v1/queue/:repositoryId/chain", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const project = await c.env.DB.prepare(
      "SELECT attested_from_sequence AS epoch, chain_public AS chainPublic FROM queue_projects WHERE github_repository_id = ? AND base_ref = ?",
    )
      .bind(repositoryId, baseRef)
      .first<{ epoch: number; chainPublic: number }>();
    if (project === null) return c.json({ error: "no queue for that branch" }, 404);

    if (project.chainPublic !== 1) {
      const who = await deps.authenticate(c, c.env);
      if (!who.ok) return c.json({ error: "unauthorized" }, who.status);
    }

    const links = await readChain(c.env.DB as unknown as D1Like, repositoryId, baseRef);
    const decoder = new TextDecoder();
    return c.json({
      epochStartsAt: project.epoch,
      links: links.map((l) => ({ digest: l.digest, sequence: l.sequence, record: decoder.decode(l.bytes), jws: l.jws })),
    });
  });

  return app;
}

