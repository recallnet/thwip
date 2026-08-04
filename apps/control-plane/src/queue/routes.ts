import { Hono } from "hono";
import { queueKey, TERMINAL_ENTRY_STATES, type BlockingReason } from "@thwip/queue-domain";
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
  requestTurn,
  confirmOnly,
  recordOnly,
  diagnose,
  walkToMergeReady,
  type QueueSnapshot,
} from "./queue-operations.js";
import { loadQueueState, withQueueState } from "./queue-state.js";
import {
  capabilityFor,
  deviceKeyClaimedByAnother,
  isPrincipalConnected,
  recordHeartbeat,
  requiresDeviceOnly,
  wellFormedDeviceKeyId,
} from "./runners.js";
import {
  atLeast,
  repositoryAccess,
  REPOSITORY_FORBIDDEN,
  REPOSITORY_READ_ONLY,
  type RepositoryLevel,
} from "./repository-access.js";
import {
  deriveReadiness,
  foldCapability,
  nonThwipCheckState,
  reviewGates,
  type PlatformHealth,
  type PullRequestGates,
  type ReadinessFacts,
} from "./readiness.js";
import { nextAction, turnCheckUpdates, unplaceableUpdate, type TurnCheckUpdate } from "./turn-check.js";
import { proofBindingFrom, proofShortfall, workReceiptDigestFrom, type ProofBinding } from "./work-receipt.js";
import { unsatisfiedRequiredChecks, type RequiredCheckState } from "./github-port.js";
import type { CandidateStateReason, IntegratedCandidate } from "./candidate.js";
import {
  authorizationFor,
  readAttestation,
  readChain,
  reuseEvidenceFor,
  signReusedIntent,
  signReusedRecord,
  signVerifiedIntent,
  signVerifiedRecord,
  storeAttestation,
  transitionRecordFor,
  verifiedEvidenceFor,
} from "./attestation.js";
import { applyHeal, planHeal, type HealPlan } from "./chain-heal.js";
import { findingsForChain } from "./chain-self-check.js";
import {
  DEFAULT_MERGE_METHOD,
  mergeCommitMessage,
  mergeCommitTitle,
  mergeOperationId,
  type MergeMethod,
} from "./merge-commit.js";
import { confirmMergeAbsence, type AbsenceVerdict } from "./merge-absence.js";
import type { MergeIntent, MergeWriteOutcome, MergeWriter } from "./merge-write.js";
import {
  parseQueueDecision,
  parseTransitionRecord,
  requiredSuitesDigest,
  type Sha256,
  type TransitionRecordV1,
} from "@thwip/queue-protocol";
import { buildBaseCorrectionRecord, signTransitionRecord } from "./evidence.js";
import type { SnapshotQueueStore } from "./snapshot-store.js";
import { namesNoDecision, type QueueCommands } from "./commands.js";
import {
  candidateResultBytes,
  candidateResultDigest,
  decideCandidate,
  requiresIntegratedRun,
  requiresRemoteVerification,
} from "./candidate-verdict.js";
import { getEvidence, putEvidence, queueDecisionRecorder, type R2Like } from "./evidence-store.js";
import { localRunEvidenceFor } from "./local-run-gate.js";
import { signLocalRunAssignment } from "./assignment.js";
import {
  acceptedReceiptFor,
  issuedAssignment,
  issuedAssignmentForAttempt,
  recordAcceptedReceipt,
  recordIssuedAssignment,
} from "./assignment-store.js";
import {
  acceptIntegrationReceipt,
  integrationReceiptBytes,
  integrationReceiptDigest,
  INTEGRATION_RECEIPT_NAMESPACE,
  type SubmittedReceipt,
} from "./integration-receipt.js";
import { verifySshSigEd25519 } from "../sshsig-verify.js";
import { DEFAULT_TIMINGS } from "./commands.js";
import type { CandidateSuite } from "./store.js";
import {
  candidateVerdict as readCandidateVerdict,
  claimCandidateDispatch,
  recordCandidateVerdict,
} from "./candidate-store.js";
import { readQueue, recordMergeFromIntent, type RecordFromIntentDeps } from "./record-from-intent.js";
import { authorizationResponse, authorizeTurn } from "./authorize-turn.js";
import {
  driveLane,
  mergeLaneFor,
  recordMergedTransition,
  storeEvidence,
  type DriveLaneOutcome,
} from "./merge-lane.js";

/**
 * The dependencies `recordMergeFromIntent` needs, assembled from the pieces
 * every caller already has: the four reads a route's `deps` carries, the
 * evidence writer above, and however that caller runs a queue command.
 *
 * One place builds this shape rather than two so `/repair` and the tick's
 * orphaned-write sweep stay wired to the same signing key, the same evidence
 * bucket, and the same reads, and a change to any of them only has one call
 * site to update.
 */
export function recordFromIntentDepsFor<TEnv extends QueueRouteEnv>(
  reads: {
    commitFacts: RecordFromIntentDeps<TEnv>["commitFacts"];
    baseContainsSha: RecordFromIntentDeps<TEnv>["baseContainsSha"];
    activePolicy: RecordFromIntentDeps<TEnv>["activePolicy"];
    signRecordBytes: RecordFromIntentDeps<TEnv>["signRecordBytes"];
  },
  onQueue: RecordFromIntentDeps<TEnv>["onQueue"],
): RecordFromIntentDeps<TEnv> {
  return {
    commitFacts: reads.commitFacts,
    baseContainsSha: reads.baseContainsSha,
    activePolicy: reads.activePolicy,
    signRecordBytes: reads.signRecordBytes,
    storeEvidence,
    onQueue,
  };
}

/**
 * Verify one branch's chain and work out the remedy for every finding.
 *
 * One producer for both heal routes, so what the page shows and what the button
 * does cannot drift apart. The plan the POST carries out is computed by this,
 * from a fresh verification, at the moment it runs.
 */
async function healPlans<TEnv extends QueueRouteEnv>(
  env: TEnv,
  reads: { commitFacts: RecordFromIntentDeps<TEnv>["commitFacts"] },
  repositoryId: string,
  baseRef: string,
): Promise<{ plans: HealPlan[] } | { error: string }> {
  const db = env.DB as unknown as D1Like;
  const project = await db
    .prepare(
      "SELECT attested_from_sequence AS epoch FROM queue_projects WHERE github_repository_id = ? AND base_ref = ?",
    )
    .bind(repositoryId, baseRef)
    .first<{ epoch: number }>();
  if (project === null) return { error: "no queue for that branch" };

  const findings = await findingsForChain(db, { repositoryId, baseRef, epochStartsAt: project.epoch });
  const plans: HealPlan[] = [];
  for (const finding of findings) {
    plans.push(await planHeal(env, db, reads, { repositoryId, baseRef, finding }));
  }
  return { plans };
}

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

/**
 * The attempt a record cites, where its kind cites one.
 *
 * A correction repeats it rather than inventing one, so a correction can never
 * reattribute a merge to a turn that did not ask for it. A record with no
 * attempt (a genesis, an observed external move) has nothing to repeat and is
 * refused rather than given a blank.
 */
function correctedAttemptId(record: TransitionRecordV1): string | null {
  switch (record.kind) {
    case "verified-merge":
      return record.verifiedMerge.attemptId;
    case "reused-proof-merge":
      return record.reusedProof.attemptId;
    case "candidate-verified-merge":
      return record.candidateVerified.attemptId;
    case "override-merge":
      return record.override.attemptId;
    case "base-correction":
      return record.correction.attemptId;
    default:
      return null;
  }
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

/**
 * Which queue a request is about.
 *
 * Twelve routes parsed this the same way and answered both failures with
 * "invalid queue key", which names the id whichever input was actually wrong.
 * Someone holding a correct repository id read that as "your id is wrong" and
 * went looking for an internal database key that does not exist. On the public
 * chain route an outside auditor gets no second chance to guess.
 */
function requestedQueue(c: {
  req: { param(name: string): string | undefined; query(name: string): string | undefined };
}): { repositoryId: string; baseRef: string } | { error: string } {
  const repositoryId = decimal(c.req.param("repositoryId"));
  if (repositoryId === null) return { error: "the repository id must be GitHub's numeric repository id" };
  const baseRef = branchRef(c.req.query("ref"));
  if (baseRef === null) return { error: "ref must name a branch, like refs/heads/main" };
  return { repositoryId, baseRef };
}

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


/** What a caller may read to settle whether a merge landed. */
export interface MergeAbsenceDeps {
  /**
   * What GitHub says the pull request is now, or null when it could not be read.
   * Null is not a negative.
   */
  pullRequestMergeState?(
    env: QueueRouteEnv,
    repositoryId: string,
    pullRequestNumber: number,
  ): Promise<{ merged: boolean; mergeCommitSha: string | null } | null>;
  /** Whether the base branch already contains a commit, from git ancestry. */
  baseContainsSha?(
    env: QueueRouteEnv,
    repositoryId: string,
    baseRef: string,
    sha: string,
  ): Promise<boolean | null>;
  /** The backoff between reads. Overridden in tests so they do not wait it out. */
  sleep?(ms: number): Promise<void>;
}

/**
 * Confirm, from GitHub, that an attempt's merge really did not happen.
 *
 * Unknown whenever the queue has no way to read: a service that cannot check
 * must not certify a negative on somebody else's single read, which is the whole
 * reason the chain lost pull requests 96, 97 and 105.
 */
async function confirmAbsenceFor(
  env: QueueRouteEnv,
  deps: MergeAbsenceDeps,
  repositoryId: string,
  baseRef: string,
  attemptId: string,
): Promise<AbsenceVerdict> {
  const readPullState = deps.pullRequestMergeState;
  const containsSha = deps.baseContainsSha;
  if (readPullState === undefined || containsSha === undefined) {
    return { kind: "unknown", reason: "this deployment cannot read GitHub to confirm a merge did not happen" };
  }

  const { store } = await readQueue(env, repositoryId, baseRef);
  const state = store.state();
  const attempt = state.attempts.get(attemptId);
  const entry = attempt === undefined ? undefined : state.entries.get(attempt.entryId);
  if (attempt?.headSha === undefined || attempt.headSha === null || entry === undefined) {
    return { kind: "unknown", reason: "no pinned attempt to read a merge outcome for" };
  }
  const headSha = attempt.headSha;
  const pullRequestNumber = entry.pullRequestNumber;

  return confirmMergeAbsence(
    {
      readPull: () => readPullState(env, repositoryId, pullRequestNumber),
      baseContainsHead: () => containsSha(env, repositoryId, baseRef, headSha),
    },
    deps.sleep === undefined ? {} : { sleep: deps.sleep },
  );
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
  decide: (parts: { store: SnapshotQueueStore; commands: QueueCommands }) => T | Promise<T>,
  publish?: (update: TurnCheckUpdate) => Promise<void>,
): Promise<{ result: T; snapshot: QueueSnapshot }> {
  const db = env.DB as unknown as D1Like;
  const recordDecision = queueDecisionRecorder({
    db,
    bucket: env.EVIDENCE as unknown as R2Like | undefined,
    repositoryId,
  });
  let before: QueueSnapshot | null = null;
  const out = await withQueueState(db, repositoryId, baseRef, async (store) => {
    // Read before the commands run, so what changed can be worked out afterwards
    // rather than guessed at. Re-read on every retry, because the state this
    // attempt started from is the only honest baseline for what it changed.
    before = buildSnapshot(store);
    const commands = commandsFor(store, undefined, recordDecision);
    // Whatever is already due, before anything else.
    //
    // A Durable Object has an alarm; D1 does not. Without this, an offer nobody
    // claimed never expires, and an offer that never expires holds the lane
    // forever. This is what the alarm did, minus the waking up: the queue is
    // touched on every authorization, every webhook and every nudge, and the
    // document is loaded already, so catching up costs nothing.
    await commands.runAlarm();
    const result = await decide({ store, commands });

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
      await commands.tick({ idempotencyKey: `settle:${store.generation()}` });
    }
    return { result, snapshot: buildSnapshot(store) };
  });
  try {
    await projectQueueState(db, projectionMessageFrom(repositoryId, baseRef, out.snapshot));
  } catch (error) {
    // The projection may lag; the command already succeeded, so this is not
    // fatal. It still has to be seen: a write that fails every time looks, from
    // out here, identical to one that never fails, and that is how a dashboard
    // came to show a stale readiness with nothing to explain it.
    console.error(`[queue projection] write failed for ${repositoryId} ${baseRef}:`, error);
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

/** What a refused command said, for a caller that has to be told why. */
function commandDetail(result: { readonly status: string; readonly detail?: string }): string {
  return result.detail ?? result.status;
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

/**
 * What a repository-scoped path requires of its caller, keyed by the segment
 * after the repository id.
 *
 * The gate below applies this, so a route added to this file is guarded before
 * its first line runs. Thirteen routes each remembering to check for themselves
 * is how a signed-in member of one organization came to be able to pause,
 * rebaseline and reconcile another organization's queue: every one of them
 * called `authenticate`, which says the caller holds a session somewhere and has
 * never said anything about the repository in the path. It is the same shape
 * that produced twelve copies of a queue-key guard carrying the same wrong
 * message.
 *
 * A route that establishes access some other way, or that needs less than the
 * default, is listed here, in one place, with the reason. The default is write,
 * so forgetting to list a route makes it stricter, never weaker.
 */
interface Requirement {
  /**
   * A GitHub Actions OIDC token minted in this repository. `only` takes nothing
   * else; `or` accepts it in place of a session.
   */
  readonly token?: "only" | "or";
  /** The route settles access for itself, and says why where it does it. */
  readonly route?: true;
  /** The floor a session has to clear on this repository. */
  readonly need?: RepositoryLevel;
}

const REPOSITORY_ACCESS: Readonly<Record<string, Requirement>> = {
  // The pinned workflow's own calls. Each verifies a GitHub Actions OIDC token
  // and refuses one minted for another repository, which binds the repository
  // harder than a permission row does. A workflow holds no session and belongs
  // to no organization, so asking it for one would refuse it outright.
  authorize: { token: "only" },
  "candidate-result": { token: "only" },
  merged: { token: "only" },
  "not-merged": { token: "only" },
  // Either identity. The merge workflow polls these with the token it
  // authorizes with; a person or the CLI arrives with a session, and that half
  // still has to hold the repository. `nudge` had no authentication of any
  // kind, and it drives GitHub Actions on the repository it names.
  candidate: { token: "or", need: "read" },
  nudge: { token: "or", need: "write" },
  // The route decides, because the answer turns on a `chain_public` row and the
  // order of its refusals is what stops a caller walking the numeric repository
  // id space. See the route, and `chain-route.test.ts`, which pins that order.
  chain: { route: true },
  // Reading the lane and asking it to explain itself. Both are what somebody
  // with triage on the repository is there to do, and neither moves anything.
  "": { need: "read" },
  explain: { need: "read" },
};

/**
 * Write, for everything not listed: joining the queue, cancelling, ticking,
 * heartbeating a runner. It is what GitHub requires to push the branch these
 * routes exist to merge into, and the walk to a merge already refuses a sponsor
 * holding less.
 */
const REPOSITORY_DEFAULT: Requirement = { need: "write" };

/**
 * The caller the gate established, for the handlers that name them.
 *
 * `isAdmin` is the gate's answer about this repository, not the session's about
 * whichever organization it selected. Set from the level the gate resolved: an
 * owner of the organization that owns the repository, or somebody GitHub calls
 * an admin of the repository itself. Read straight off `authenticate` it said
 * an administrator of one organization was an administrator of every other.
 */
interface QueueCaller {
  readonly principalId: string;
  readonly githubUserId: string;
  readonly isAdmin: boolean;
  readonly operator?: boolean;
}

export function queueRoutes<TEnv extends QueueRouteEnv>(deps: {
  /** Who the caller is, from the existing session or bearer auth. */
  authenticate(c: { req: { raw: Request } }, env: TEnv): Promise<
    | {
        ok: true;
        principalId: string;
        githubUserId: string;
        isAdmin: boolean;
        /**
         * The deployment's operator token rather than a person's session. It
         * is not a principal in any organization, so it has no membership to
         * compare — see `repository-access.ts`.
         */
        operator?: boolean;
      }
    | { ok: false; status: 401 | 403 }
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
    /**
     * The activated document itself, which an assignment digests rather than
     * trusting a digest handed alongside it, plus what the pipeline pins. Only
     * the profiles that dispatch a run to a device read these.
     */
    document?: unknown;
    version?: number;
    daggerModuleDigest?: string | null;
    daggerEngineDigest?: string | null;
  } | null>;
  /**
   * The integrated candidate GitHub has computed for a pull request.
   *
   * What a device is dispatched to run under `fresh`, so it comes from GitHub
   * rather than from the machine asking for work. When there is no candidate to
   * hand out this says which of the eight states GitHub is in, because the
   * caller acts on them differently: a conflict ends the turn, a mergeability
   * GitHub has not finished computing does not. Null only when the repository
   * itself could not be read, which says nothing about the pull request.
   */
  integratedCandidate?(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
    pullRequestNumber: number,
  ): Promise<IntegratedCandidate | null>;
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
      /** The suites the activated policy requires, which the verifier runs. */
      requiredSuites: readonly string[];
    },
  ): Promise<{ ok: true } | { ok: false; status: number; detail: string }>;
  /** Queue configuration for a branch, or null when the branch has no queue. */
  queueProject(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
  ): Promise<{ activationState: string; mergeMethod: MergeMethod; mergeWriter?: MergeWriter } | null>;
  /**
   * Perform the merge the queue just authorized, from the Worker.
   *
   * Optional, because a deployment that cannot reach GitHub with the App's own
   * credential has no way to do it and must go on letting the workflow write.
   * Absent is the same answer as `merge_writer = 'workflow'`.
   */
  mergeWrite?(env: TEnv, repositoryId: string, intent: MergeIntent): Promise<MergeWriteOutcome>;
  /** The activated principal for a GitHub user id, or null. */
  principalFor(env: TEnv, githubUserId: string): Promise<string | null>;
  /**
   * Who wrote a pull request and which branch it targets, from GitHub.
   *
   * All three settle something a caller must not get to choose. The author is
   * the entry's sponsor, so a turn is offered to the person whose work it is
   * rather than to whoever happened to run the command; the base branch is
   * which queue the entry belongs on, so one pull request cannot be placed on
   * two of them; and whether the author is a bot decides whether there is a
   * person to be accountable for the turn at all. Null when the pull request
   * could not be read, which is a refusal rather than a licence to guess.
   */
  pullRequestPlacement(
    env: TEnv,
    repositoryId: string,
    pullRequestNumber: number,
  ): Promise<{
    authorGithubUserId: string;
    baseRef: string;
    authorIsBot: boolean;
    /** Whether the pull request is a draft, which no caller may assert. */
    draft: boolean;
    /** The head the pull request is on now, which no caller may assert. */
    headSha: string;
  } | null>;
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
  /**
   * What GitHub says the pull request is now, or null when it could not be read.
   *
   * The queue reads this itself before it will record that a merge did not
   * happen. A caller that saw one refusal saw one call's result, not the fate of
   * the pull request.
   */
  pullRequestMergeState?(
    env: TEnv,
    repositoryId: string,
    pullRequestNumber: number,
  ): Promise<{ merged: boolean; mergeCommitSha: string | null } | null>;
  /**
   * Whether the base branch already contains a commit, from git ancestry rather
   * than from the pull request's own flag. Null when it cannot be read.
   *
   * Two questions, one read. It settles whether a merge the pull request denies
   * really did land, and it settles whether the commit a record is about to name
   * as the branch's new state is on the branch at all.
   */
  baseContainsSha(env: TEnv, repositoryId: string, baseRef: string, sha: string): Promise<boolean | null>;
  /**
   * What the branch requires of a head, and what the head says about it.
   *
   * Read before the queue prepares a merge. A required check that is not on the
   * head makes the merge PUT a certain 405, and the queue used to learn that
   * from the rejection — after it had signed an intent and minted an operation,
   * with the attempt holding the lane and everything behind it stopped.
   *
   * Null when GitHub could not be read, which is unknown rather than a refusal.
   */
  requiredCheckState?(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
    headSha: string,
  ): Promise<RequiredCheckState | null>;
  /**
   * Whether the repository is still the one this queue's policy assumes.
   *
   * Three facts, and the queue authorized merges without any of them. The branch
   * ruleset can be edited or deleted, so the checks and the ownership rule the
   * queue was set up around stop being enforced and anybody can push to the
   * branch the queue believes it owns. The App installation can lose a
   * permission, so the merge the queue is about to certify is one it cannot
   * perform. And the sponsor's repository access can be taken away between the
   * offer and the merge, so the queue merges on behalf of somebody who may no
   * longer write here.
   *
   * Read on the walk to a merge and nowhere else. A pull request waiting its
   * turn asks this route once a minute, and none of the three can be settled
   * without reading GitHub.
   *
   * Null when GitHub could not be read, which is unknown rather than a refusal,
   * for the same reason `requiredCheckState` is: a bad minute at GitHub must not
   * stop the queue.
   */
  platformHealth?(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
    sponsorGithubUserId: string,
  ): Promise<PlatformHealth | null>;
  /**
   * What GitHub's own pull-request rule asks of this pull request, and whether
   * it is met.
   *
   * Reviews, code owners, approval after the last push, conversation
   * resolution and mergeability. GitHub enforces every one of them at the ref
   * update the merge workflow performs, and nothing here read any of them: the
   * four review facts had no writer at all, so a pull request with no approval
   * was called ready, took the lane ahead of everyone waiting, ran the whole
   * pipeline, and collected a signed merge intent for a merge GitHub was never
   * going to permit. The 422 came last and the sentence explaining it stayed in
   * an Actions log.
   *
   * Read where `requiredCheckState` is read, on the same terms: only when
   * nothing else already blocks the entry, so a waiting pull request asking
   * once a minute costs nothing. Null when GitHub could not be read, which is
   * unknown rather than a refusal.
   */
  pullRequestGates?(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
    pullRequestNumber: number,
    headSha: string,
  ): Promise<PullRequestGates | null>;
  /** The backoff between confirmation reads. Overridden in tests. */
  sleep?(ms: number): Promise<void>;
}) {
  const app = new Hono<{ Bindings: TEnv; Variables: { caller: QueueCaller } }>();

  /**
   * Establish that the caller may act on the repository in the path, before any
   * handler runs.
   *
   * Registered once, over everything under `/v1/queue`, so access is a property
   * of the prefix rather than a line each handler is trusted to copy. A path
   * whose third segment is not a numeric repository id falls straight through:
   * `/v1/queue/records/:digest` names no repository, and a malformed id is the
   * handler's 400 to give rather than a refusal that hides it.
   */
  app.use("/v1/queue/*", async (c, next) => {
    const segments = c.req.path.split("/");
    const repositoryId = decimal(segments[3]);
    if (repositoryId === null) return next();

    const requirement = REPOSITORY_ACCESS[segments[4] ?? ""] ?? REPOSITORY_DEFAULT;
    if (requirement.route === true || requirement.token === "only") return next();

    if (requirement.token === "or") {
      const claims = await deps.verifyOidc(c, c.env);
      if (claims !== null && String(claims["repository_id"] ?? "") === repositoryId) return next();
    }

    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);
    const level = await repositoryAccess(c.env.DB as unknown as D1Like, repositoryId, who);
    // One refusal for a repository this caller holds nothing on and one for a
    // repository nobody has onboarded. Two answers would be the enumeration
    // the chain route's ordering already exists to prevent, arriving through a
    // different door.
    if (!atLeast(level, "read")) return c.json({ error: REPOSITORY_FORBIDDEN }, 403);
    // Past that point the caller has been told by GitHub that the repository
    // exists, so a refusal may say what they are short of.
    if (!atLeast(level, requirement.need ?? "write")) return c.json({ error: REPOSITORY_READ_ONLY }, 403);
    // `isAdmin` is the repository's answer, not the session's. `authenticate`
    // reports the role of whichever organization the session selected, so a
    // handler reading it directly made an owner of one organization an
    // administrator of every other, and it says nothing at all about somebody
    // who holds this repository and belongs to no organization.
    c.set("caller", { ...who, isAdmin: level === "admin" });
    return next();
  });

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
    decide: (parts: { store: SnapshotQueueStore; commands: QueueCommands }) => T | Promise<T>,
  ) =>
    runOnQueue(env, repositoryId, baseRef, decide, (update) =>
      deps.publishTurnCheck === undefined
        ? Promise.resolve()
        : deps.publishTurnCheck(env, repositoryId, update),
    );

  const { recordLandedMerge, resolveNotMerged, performMergeFromWorker } = mergeLaneFor(deps, onQueue);

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
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

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
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

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
    } catch (error) {
      // Same argument as the write in `runOnQueue`: the read already has its
      // answer, so this cannot be fatal, but a failure here is a projection
      // that is never getting backfilled, and that has to be visible.
      console.error(`[queue projection] write failed for ${repositoryId} ${baseRef}:`, error);
    }
    return c.json({ ...snapshot, source: "queue" });
  });

  /**
   * Join the queue. Durable: accepted before reviews finish, and the entry keeps
   * its place through failure (plan.md §7.1).
   *
   * Which queue the entry lands on comes from GitHub, never from the request:
   * the branch was the caller's to name once, so a pull request could be placed
   * on a queue it does not target, which is how one pull request came to hold
   * two places in line.
   *
   * The sponsor is the author when the author is a person. This route used to
   * sponsor whoever called it while the `pull_request` webhook sponsored the
   * author, so the same pull request had two sponsors depending on which
   * arrived first, and under `fresh` the turn went to one person while the
   * queue waited for a machine belonging to the other. What stops that
   * returning is that the sponsor is decided once, at entry creation, and no
   * later path recomputes it: `QueueRequested` on an entry that already exists
   * is a no-op, and the webhook never overwrites a recorded sponsor.
   *
   * A bot has no principal and no fairness share, so a bot's pull request could
   * not be queued by anyone. The human who joins sponsors it, and takes the
   * accountability along with the share. Nobody can name a sponsor other than
   * themselves, which is the part that had to stay.
   */
  app.post("/v1/queue/:repositoryId/entries", async (c) => {
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    const body = (await c.req.json().catch(() => ({}))) as {
      pullRequestNumber?: number;
      headSha?: string;
    };
    if (typeof body.pullRequestNumber !== "number" || !Number.isSafeInteger(body.pullRequestNumber)) {
      return c.json({ error: "pullRequestNumber required" }, 400);
    }
    if (typeof body.headSha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(body.headSha)) {
      return c.json({ error: "headSha must be a lowercase hex object id" }, 400);
    }

    const placement = await deps.pullRequestPlacement(c.env, repositoryId, body.pullRequestNumber);
    if (placement === null) {
      return c.json(
        { error: "PULL_REQUEST_UNREADABLE", detail: "GitHub did not say who wrote this pull request or where it goes" },
        502,
      );
    }
    if (placement.baseRef !== baseRef) {
      return c.json(
        { error: "WRONG_QUEUE", detail: `this pull request targets ${placement.baseRef}` },
        409,
      );
    }
    const who = c.get("caller");
    const sponsorPrincipalId = placement.authorIsBot
      ? who.principalId
      : await deps.principalFor(c.env, placement.authorGithubUserId);
    if (sponsorPrincipalId === null) {
      return c.json(
        { error: "AUTHOR_NOT_ACTIVATED", detail: "the pull request's author has no activated principal here" },
        409,
      );
    }

    const entryId = `entry_${repositoryId}_${body.pullRequestNumber}`;
    const headSha = body.headSha;
    const pullRequestNumber = body.pullRequestNumber;
    const sponsorGithubUserId = placement.authorIsBot ? who.githubUserId : placement.authorGithubUserId;
    const { result } = await onQueue(c.env, repositoryId, baseRef, ({ store, commands }) =>
      requestTurn(commands, store, {
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
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    const who = c.get("caller");

    const reason = c.req.query("reason") ?? "withdrawn by the queue owner";
    const entryId = c.req.param("entryId");
    const { result, snapshot } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) =>
      commands.cancel({
        idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `cancel:${entryId}`),
        entryId,
        actorPrincipalId: who.principalId,
        reason,
      }),
    );

    // Ejecting frees the lane, and a freed lane is offered to somebody else. That
    // offer expires in ninety seconds, so telling nobody about it wastes a turn
    // and, on a quiet queue, stalls it entirely.
    await driveLane(c.env, deps, repositoryId, baseRef, snapshot);
    return c.json({ result }, result.status === "rejected" ? 409 : 200);
  });

  /**
   * Ask the scheduler whether a turn is due. Idempotent and safe to call often;
   * the object refuses to offer while a lane is busy or the queue is paused.
   */
  app.post("/v1/queue/:repositoryId/tick", async (c) => {
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    const key = idempotencyKey(c.req.header("idempotency-key"), `tick:${crypto.randomUUID()}`);
    const { result, snapshot } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) =>
      commands.tick({ idempotencyKey: key }),
    );
    await driveLane(c.env, deps, repositoryId, baseRef, snapshot);
    return c.json({ result });
  });

  /**
   * A runner says it is here (plan.md §5.0).
   *
   * The principal comes from the session, never the body, so a runner cannot
   * claim to be somebody else. Upserts the heartbeat row; only on the
   * absent-to-present transition does this touch any queue document, so a
   * runner polling every fifteen seconds costs one row write per call and a
   * queue write only the first time it shows up.
   *
   * Being signed in is not enough to reach it. That absent-to-present
   * transition compare-and-swaps the repository's queue document and then
   * drives the lane, which fires a `repository_dispatch` on the repository, so
   * a stranger who could pass this gate could spend another organization's
   * Actions minutes once per grace window for as long as they cared to keep
   * calling. Membership is checked before anything is written.
   */
  app.post("/v1/queue/:repositoryId/runners/heartbeat", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    if (repositoryId === null) return c.json({ error: "invalid repository id" }, 400);

    const who = c.get("caller");
    const db = c.env.DB as unknown as D1Like;

    const body = (await c.req.json().catch(() => ({}))) as { deviceKeyId?: unknown };
    if (!wellFormedDeviceKeyId(body.deviceKeyId)) {
      return c.json({ error: "deviceKeyId must be a device key id this deployment issues" }, 400);
    }
    const deviceKeyId = body.deviceKeyId;
    if (await deviceKeyClaimedByAnother(db, deviceKeyId, who.githubUserId)) {
      return c.json({ error: "that device key belongs to somebody else, or has been revoked" }, 403);
    }

    const now = new Date().toISOString();
    const { wasOffline } = await recordHeartbeat(db, {
      repositoryId,
      principalId: who.principalId,
      deviceKeyId,
      now,
    });

    const projects = await db
      .prepare("SELECT base_ref AS baseRef FROM queue_projects WHERE github_repository_id = ? AND enabled = 1")
      .bind(repositoryId)
      .all<{ baseRef: string }>();

    let holdsOffer = false;
    for (const { baseRef } of projects.results) {
      if (wasOffline) {
        // A heartbeat names a repository, not a branch: the principal's Ready
        // entry could sit on any base ref this repository queues, so every
        // enabled one is checked.
        const { snapshot } = await onQueue(c.env, repositoryId, baseRef, ({ store, commands }) => {
          for (const entry of buildSnapshot(store).entries) {
            // A finished entry is finished. Readiness is derived for entries
            // that could still take a turn, and a cancelled one never will, so
            // re-deriving it onto one left the queue asserting that a pull
            // request nobody can merge was schedulable with nothing blocking it.
            // The reducer keeps a terminal entry terminal; this path went around
            // it by writing the two fields the reducer sets before it looks.
            if (TERMINAL_ENTRY_STATES.includes(entry.state as (typeof TERMINAL_ENTRY_STATES)[number])) continue;
            if (
              entry.sponsorPrincipalId === who.principalId &&
              !entry.schedulerEligible &&
              entry.primaryReason === "AGENT_OFFLINE"
            ) {
              commands.evaluateReadiness({
                idempotencyKey: `runner-online:${entry.entryId}:${now}`,
                entryId: entry.entryId,
                ready: true,
                schedulerEligible: true,
                primaryReason: null,
              });
            }
          }
        });
        await driveLane(c.env, deps, repositoryId, baseRef, snapshot);
        if (snapshot.entries.some((e) => e.sponsorPrincipalId === who.principalId && e.state === "Offered")) {
          holdsOffer = true;
        }
      } else {
        // No write on the common case: read the document as it stands rather
        // than run it through the compare-and-swap just to answer a question.
        const loaded = await loadQueueState(db, repositoryId, baseRef);
        const snapshot = buildSnapshot(loaded.store);
        if (snapshot.entries.some((e) => e.sponsorPrincipalId === who.principalId && e.state === "Offered")) {
          holdsOffer = true;
        }
      }
    }

    return c.json({ holdsOffer });
  });

  /**
   * A device takes the turn it was offered, and is told what to run (plan.md §19.3).
   *
   * This is the half of `fresh` that had never been built. The queue holds the
   * integrated candidate, signs an assignment naming that exact tree, this
   * attempt and this device, and hands it over. The device can check the
   * signature itself, which is why the signed record goes back rather than a
   * summary of it.
   *
   * Nothing here is taken on trust from the body except which attempt is being
   * claimed and from which machine. The principal comes from the session, the
   * candidate comes from GitHub, the suites come from the activated policy, and
   * the reducer decides whether this offer was still there to take.
   */
  app.post("/v1/queue/:repositoryId/claim", async (c) => {
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;
    const who = c.get("caller");
    const db = c.env.DB as unknown as D1Like;

    const body = (await c.req.json().catch(() => ({}))) as { attemptId?: unknown; deviceKeyId?: unknown };
    if (typeof body.attemptId !== "string" || body.attemptId.length === 0 || body.attemptId.length > 128) {
      return c.json({ error: "attemptId required" }, 400);
    }
    if (!wellFormedDeviceKeyId(body.deviceKeyId)) {
      return c.json({ error: "deviceKeyId must be a device key id this deployment issues" }, 400);
    }
    const attemptId = body.attemptId;
    const deviceKeyId = body.deviceKeyId;
    if (await deviceKeyClaimedByAnother(db, deviceKeyId, who.githubUserId)) {
      return c.json({ error: "that device key belongs to somebody else, or has been revoked" }, 403);
    }

    const project = await deps.queueProject(c.env, repositoryId, baseRef);
    if (project === null) return c.json({ error: "no queue on this branch" }, 404);

    // Only a profile that dispatches work to a device has an assignment to
    // give. Under `fast` the evidence is the proof already on the head and the
    // server claims its own offer, so a device asking for work here would be
    // told to run something nothing would ever read.
    const policy = await deps.activePolicy(c.env, repositoryId);
    if (!requiresDeviceOnly(policy?.securityProfile ?? null)) {
      return c.json({ error: "PROFILE_DOES_NOT_DISPATCH", detail: "this repository's profile runs no work on a device" }, 409);
    }
    if (policy === null || policy.requiredSuites.length === 0) {
      return c.json(
        { error: "NO_REQUIRED_SUITES", detail: "the active policy names no suite for a device to run" },
        409,
      );
    }

    const { snapshot } = await readQueue(c.env, repositoryId, baseRef);
    if (snapshot.activeAttemptId !== attemptId) {
      return c.json({ error: "ATTEMPT_NOT_CURRENT", detail: "that attempt does not hold the lane" }, 409);
    }
    const entry = snapshot.entries.find((e) => e.entryId === snapshot.activeEntryId);
    if (entry === undefined) {
      return c.json({ error: "ATTEMPT_NOT_CURRENT", detail: "that attempt does not hold the lane" }, 409);
    }
    if (entry.sponsorPrincipalId !== who.principalId) {
      // The offer belongs to the pull request's sponsor. Somebody else running
      // its suites is somebody else's account of code they do not own.
      return c.json({ error: "NOT_YOUR_OFFER", detail: "this turn was offered to another principal" }, 403);
    }
    // A re-ask from the machine that already holds it gets the same assignment
    // back. A device that lost its answer must not be pushed into a second turn,
    // and a different machine must not be given work this attempt already
    // assigned: the reducer holds an assignment immutable, and so does storage.
    const already = await issuedAssignmentForAttempt(db, attemptId);
    if (already !== null) {
      if (already.deviceKeyId !== deviceKeyId) {
        return c.json({ error: "ALREADY_CLAIMED", detail: "another machine holds this attempt" }, 409);
      }
      const record = await readAttestation(db, already.assignmentDigest);
      return c.json({
        assignmentId: already.assignmentId,
        assignmentDigest: already.assignmentDigest,
        assignment: record?.jws ?? null,
        candidateSha: already.candidateSha,
        candidateTreeOid: already.candidateTreeOid,
        requiredSuites: already.requiredSuites,
        executionSeconds: already.executionSeconds,
      });
    }

    if (entry.state !== "Offered") {
      return c.json({ error: "ALREADY_CLAIMED", detail: `the turn is ${entry.state}` }, 409);
    }
    if (!(await isPrincipalConnected(db, repositoryId, who.principalId, new Date().toISOString()))) {
      return c.json(
        { error: "RUNNER_NOT_CONNECTED", detail: "heartbeat first, so the queue knows this machine is here" },
        409,
      );
    }

    if (deps.integratedCandidate === undefined) {
      return c.json({ error: "CANDIDATE_UNAVAILABLE", detail: "this deployment cannot resolve a candidate" }, 503);
    }
    const candidate = await deps.integratedCandidate(c.env, repositoryId, baseRef, entry.pullRequestNumber);
    if (candidate === null || candidate.status !== "pinned") {
      // GitHub computes mergeability asynchronously, and a pull request that
      // cannot be integrated has no candidate at all. Neither is a reason to
      // hand a device a tree to run, and the device is told which it is.
      return c.json(
        {
          error: "CANDIDATE_UNAVAILABLE",
          detail:
            candidate === null
              ? "GitHub would not say what this pull request integrates to"
              : nextAction(candidate.reason),
        },
        409,
      );
    }

    // The proof on the head, which the assignment binds. No digest means the
    // required check has nothing to have accepted, so there is no turn to run.
    const head = await deps.commitFacts(c.env, repositoryId, candidate.headSha);
    const workReceiptDigest = head?.message === undefined ? null : await workReceiptDigestFrom(head.message);
    if (workReceiptDigest === null) {
      return c.json(
        { error: "WORK_RECEIPT_UNREADABLE", detail: "the head commit carries no readable thwip proof" },
        409,
      );
    }

    // GitHub's own id for the account that owns the repository, which is what an
    // assignment names. The organization id storage uses is this deployment's
    // key for a tenant and means nothing to a device checking the record.
    const owner = await db
      .prepare(
        `SELECT o.github_org_id AS ownerId
           FROM projects p JOIN organizations o ON o.id = p.organization_id
          WHERE p.github_repository_id = ?`,
      )
      .bind(repositoryId)
      .first<{ ownerId: string }>();
    if (owner === null || !/^[0-9]{1,32}$/.test(owner.ownerId)) {
      return c.json({ error: "OWNER_UNKNOWN", detail: "this repository's owner has no GitHub id recorded" }, 409);
    }

    // What the scheduler decided when it offered this turn. The device checks
    // the assignment against the protocol, and this field is its handle on why
    // the turn is its own; binding a digest naming no record told it nothing and
    // passed anyway, because the check only reads the field's shape.
    const queueDecisionDigest = snapshot.activeDecisionDigest;
    if (queueDecisionDigest === null || namesNoDecision(queueDecisionDigest)) {
      return c.json(
        {
          error: "QUEUE_DECISION_UNAVAILABLE",
          detail: "this turn was offered without a recorded scheduling decision; it cannot be assigned",
        },
        409,
      );
    }

    const assignmentId = `asg_${attemptId}`;
    const issuedAt = new Date().toISOString();
    const signed = await signLocalRunAssignment({
      assignmentId,
      attemptId,
      ownerId: owner.ownerId,
      git: {
        objectFormat: "sha1",
        repositoryId,
        baseRef: baseRef as `refs/heads/${string}`,
        baseSha: candidate.baseSha,
        headRepositoryId: repositoryId,
        headSha: candidate.headSha,
        candidateSha: candidate.candidateSha,
        candidateTreeOid: candidate.candidateTreeOid,
        candidateParentOids:
          project.mergeMethod === "squash" ? [candidate.baseSha] : [candidate.baseSha, candidate.headSha],
      },
      queue: {
        queueEpoch: snapshot.queueEpoch,
        turnSequence: snapshot.turnSequence,
        entryId: entry.entryId,
        pullRequestNumber: entry.pullRequestNumber,
        sponsorPrincipalId: entry.sponsorPrincipalId,
        queueDecisionDigest: queueDecisionDigest as Sha256,
      },
      policy: {
        version: policy.version ?? 1,
        securityProfile: policy.securityProfile as "fresh" | "audited",
        requiredSuites: policy.requiredSuites,
        document: policy.document ?? {},
        // Dagger where the activated pipeline pins both digests, a command
        // pipeline otherwise. Neither is inferred from anything the caller sent.
        ...(policy.daggerModuleDigest != null && policy.daggerEngineDigest != null
          ? {
              runner: "dagger" as const,
              daggerModuleDigest: policy.daggerModuleDigest as Sha256,
              daggerEngineDigest: policy.daggerEngineDigest as Sha256,
            }
          : { runner: "command" as const }),
      },
      workReceiptDigest,
      previousTransitionDigest: (snapshot.chainHead?.digest ?? null) as Sha256 | null,
      issuedAt,
      executionSeconds: DEFAULT_TIMINGS.executionSeconds,
      nonce: crypto.randomUUID(),
      runnerPrincipalId: who.principalId,
      deviceKeyId,
      signer: { sign: (bytes, typ) => deps.signRecordBytes(c.env, bytes, typ) },
    });
    if ("error" in signed) {
      return c.json({ error: "ASSIGNMENT_INVALID", detail: signed.error }, 500);
    }

    // The document first, storage second. The queue document is what says this
    // device holds the turn, and a row claiming an assignment the reducer
    // refused would block the machine that really claimed it.
    const { result: claimed } = await onQueue(c.env, repositoryId, baseRef, ({ store, commands }) => {
      if (store.state().activeAttemptId !== attemptId) return { ok: false as const, detail: "the lane moved" };
      const claim = commands.claim({
        idempotencyKey: `claim:${attemptId}:${deviceKeyId}`,
        attemptId,
        executionMode: "device",
        deviceId: deviceKeyId,
      });
      if (claim.status !== "applied" && claim.status !== "duplicate") {
        return { ok: false as const, detail: commandDetail(claim) };
      }
      commands.candidatePrepared({
        idempotencyKey: `claim:candidate:${attemptId}`,
        attemptId,
        baseSha: candidate.baseSha,
        headSha: candidate.headSha,
        candidateSha: candidate.candidateSha,
        candidateTree: candidate.candidateTreeOid,
        policyDigest: policy.policyDigest,
        runner: "local-run" as never,
      });
      const assigned = commands.assign({
        idempotencyKey: `claim:assign:${attemptId}`,
        attemptId,
        assignmentDigest: signed.digest,
      });
      return assigned.status === "applied" || assigned.status === "duplicate"
        ? { ok: true as const }
        : { ok: false as const, detail: commandDetail(assigned) };
    });
    if (!claimed.ok) return c.json({ error: "ALREADY_CLAIMED", detail: claimed.detail }, 409);

    await storeAttestation(db, {
      digest: signed.digest,
      kind: "integration-assignment",
      repositoryId,
      baseRef,
      transitionSequence: null,
      attemptId,
      bytes: signed.bytes,
      jws: signed.jws,
      ...(policy.organizationId === undefined ? {} : { organizationId: policy.organizationId }),
    });
    const stored = await recordIssuedAssignment(db, {
      assignmentId,
      repositoryId,
      baseRef,
      attemptId,
      assignmentDigest: signed.digest,
      candidateSha: candidate.candidateSha,
      candidateTreeOid: candidate.candidateTreeOid,
      principalId: who.principalId,
      deviceKeyId,
      requiredSuites: policy.requiredSuites,
      executionSeconds: DEFAULT_TIMINGS.executionSeconds,
      issuedAt,
    });
    if (stored.status === "duplicate") {
      // Another machine got there first. It holds the turn, and this one is told
      // so rather than being handed a second assignment for the same attempt.
      return c.json({ error: "ALREADY_CLAIMED", detail: "another machine holds this attempt" }, 409);
    }

    return c.json({
      assignmentId,
      assignmentDigest: signed.digest,
      assignment: signed.jws,
      candidateSha: candidate.candidateSha,
      candidateTreeOid: candidate.candidateTreeOid,
      requiredSuites: policy.requiredSuites,
      executionSeconds: DEFAULT_TIMINGS.executionSeconds,
    });
  });

  /**
   * The device's account of what it ran (plan.md §19.3).
   *
   * Accepted only when it answers the assignment this queue issued, is about the
   * tree that assignment named, comes from the device that was assigned it, and
   * is signed by that device's key. `acceptIntegrationReceipt` decides the first
   * three; the signature is checked here, because it needs key material that
   * function must never see.
   *
   * Accepting one is not a merge. It is the evidence the merge gate refuses to
   * proceed without, and the gate checks it again against the queue document.
   */
  app.post("/v1/queue/:repositoryId/receipt", async (c) => {
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;
    const who = c.get("caller");
    const db = c.env.DB as unknown as D1Like;

    const body = (await c.req.json().catch(() => ({}))) as {
      assignmentId?: unknown;
      assignmentDigest?: unknown;
      candidateTreeOid?: unknown;
      deviceKeyId?: unknown;
      suites?: unknown;
      signature?: unknown;
    };
    if (typeof body.assignmentId !== "string" || typeof body.assignmentDigest !== "string") {
      return c.json({ error: "assignmentId and assignmentDigest required" }, 400);
    }
    if (typeof body.candidateTreeOid !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(body.candidateTreeOid)) {
      return c.json({ error: "candidateTreeOid must be a lowercase hex object id" }, 400);
    }
    if (!wellFormedDeviceKeyId(body.deviceKeyId)) {
      return c.json({ error: "deviceKeyId must be a device key id this deployment issues" }, 400);
    }
    if (typeof body.signature !== "string" || body.signature.length === 0 || body.signature.length > 4096) {
      return c.json({ error: "a receipt must be signed by the device that ran it" }, 400);
    }
    const suites = Array.isArray(body.suites) ? body.suites : null;
    if (
      suites === null ||
      suites.length > 128 ||
      !suites.every(
        (s): s is { name: string; outcome: string } =>
          typeof s === "object" && s !== null && typeof (s as { name?: unknown }).name === "string" &&
          typeof (s as { outcome?: unknown }).outcome === "string",
      )
    ) {
      return c.json({ error: "suites must be a list of { name, outcome }" }, 400);
    }
    const receipt: SubmittedReceipt = {
      assignmentId: body.assignmentId,
      assignmentDigest: body.assignmentDigest,
      candidateTreeOid: body.candidateTreeOid,
      deviceKeyId: body.deviceKeyId,
      suites: suites.map((s) => ({ name: s.name, outcome: s.outcome })),
    };

    const issued = await issuedAssignment(db, receipt.assignmentId);
    // One refusal for an assignment that does not exist and one for an
    // assignment on another repository, so a caller cannot walk assignment ids
    // and learn which are real.
    if (issued === null || issued.repositoryId !== repositoryId || issued.baseRef !== baseRef) {
      return c.json({ error: "ASSIGNMENT_UNKNOWN", detail: "no such assignment on this queue" }, 404);
    }
    if (issued.principalId !== who.principalId) {
      return c.json({ error: "NOT_YOUR_ASSIGNMENT", detail: "this assignment was issued to another principal" }, 403);
    }

    // The key the receipt claims to be signed by, as this deployment knows it.
    // A key it has never seen cannot verify anything, and a revoked one must
    // not: both are refusals rather than a check quietly skipped.
    const key = await db
      .prepare(
        "SELECT public_key AS publicKey, revoked_at AS revokedAt, github_user_id AS githubUserId FROM device_keys WHERE key_id = ?",
      )
      .bind(receipt.deviceKeyId)
      .first<{ publicKey: string; revokedAt: string | null; githubUserId: string }>();
    if (key === null || key.revokedAt !== null || key.githubUserId !== who.githubUserId) {
      return c.json(
        { error: "DEVICE_KEY_UNKNOWN", detail: "this deployment holds no usable public key for that device" },
        403,
      );
    }
    const signatureOk = await verifySshSigEd25519({
      publicKey: key.publicKey,
      namespace: INTEGRATION_RECEIPT_NAMESPACE,
      message: integrationReceiptBytes(receipt),
      signatureBase64: body.signature,
    });
    if (!signatureOk) {
      return c.json({ error: "RECEIPT_SIGNATURE_INVALID", detail: "the receipt is not signed by that device" }, 403);
    }

    const verdict = acceptIntegrationReceipt(receipt, {
      assignmentId: issued.assignmentId,
      digest: issued.assignmentDigest,
      candidateTreeOid: issued.candidateTreeOid,
      deviceKeyId: issued.deviceKeyId,
      requiredSuites: issued.requiredSuites,
    });
    if (!verdict.ok) return c.json({ error: verdict.code, detail: verdict.detail }, 409);

    const receiptDigest = await integrationReceiptDigest(receipt);
    const recorded = await recordAcceptedReceipt(db, {
      assignmentId: issued.assignmentId,
      receiptDigest,
      suites: receipt.suites,
      acceptedAt: new Date().toISOString(),
    });
    if (recorded.status === "unknown-assignment") {
      return c.json({ error: "ASSIGNMENT_UNKNOWN", detail: "no such assignment on this queue" }, 404);
    }
    if (recorded.status === "duplicate") {
      const held = await acceptedReceiptFor(db, issued.attemptId);
      // The same receipt again is a retry and gets the same answer. A different
      // one asks the queue to change what it will merge on after the gate may
      // already have read the first, which is the revision the reducer refuses
      // for a late verdict.
      if (held?.receiptDigest !== receiptDigest) {
        return c.json(
          { error: "RECEIPT_ALREADY_ACCEPTED", detail: "a receipt for this assignment was already accepted" },
          409,
        );
      }
    }

    const { result: submitted, snapshot } = await onQueue(c.env, repositoryId, baseRef, ({ store, commands }) => {
      const attempt = store.state().attempts.get(issued.attemptId);
      if (attempt === undefined) return { ok: false as const, detail: "the attempt is gone" };
      if (attempt.receiptDigest !== null) {
        return attempt.receiptDigest === receiptDigest
          ? { ok: true as const }
          : { ok: false as const, detail: "another receipt is already recorded for this attempt" };
      }
      const result = commands.submitReceipt({
        idempotencyKey: `receipt:${issued.attemptId}`,
        attemptId: issued.attemptId,
        receiptDigest,
      });
      return result.status === "applied" || result.status === "duplicate"
        ? { ok: true as const }
        : { ok: false as const, detail: commandDetail(result) };
    });
    if (!submitted.ok) return c.json({ error: "RECEIPT_NOT_RECORDED", detail: submitted.detail }, 409);

    // The run is over and the merge still has to be written, which happens in
    // Actions. Under this profile nothing else asks for it: the lane was never
    // driven while the device held the turn, on purpose.
    await driveLane(c.env, deps, repositoryId, baseRef, snapshot);

    return c.json({ accepted: true });
  });

  /** Administrative pause, resume, and rebaseline (plan.md §28.5). */
  app.post("/v1/queue/:repositoryId/pause", async (c) => {
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    const who = c.get("caller");
    // The administrator of the organization that owns this repository, because
    // the gate has already established that this caller belongs to it. Read
    // before membership, `isAdmin` was a claim about whichever organization the
    // session had selected.
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
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    const who = c.get("caller");
    // The administrator of the organization that owns this repository, because
    // the gate has already established that this caller belongs to it. Read
    // before membership, `isAdmin` was a claim about whichever organization the
    // session had selected.
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
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    const who = c.get("caller");
    // The administrator of the organization that owns this repository, because
    // the gate has already established that this caller belongs to it. Read
    // before membership, `isAdmin` was a claim about whichever organization the
    // session had selected.
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
    const { result, snapshot } = await onQueue(c.env, repositoryId, baseRef, ({ store, commands }) => {
      // A result for an older attempt is stale and harmless; one for the current
      // attempt at a stale revision is a conflict and must not be applied.
      if (typeof attemptRevision === "number") {
        const standing = store.classifyCallback(verdict.attemptId, attemptRevision);
        if (standing !== "current") return { stale: standing } as const;
      }
      return { applied: commands.completeVerification(verdict) } as const;
    });
    if ("stale" in result) return c.json({ error: result.stale, code: result.stale }, 409);

    // A rejected verdict terminates the attempt and frees the lane, same as an
    // eject or a reconcile that gives up on one. An accepted verdict leaves the
    // attempt live in MergeGuard, still holding the lane, so there is nothing to
    // drive there — only the rejection path needs this.
    if (!verdict.accepted) await driveLane(c.env, deps, repositoryId, baseRef, snapshot);
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
    //
    // Through `driveLane`, not `driveTurn` directly: this candidate verdict is a
    // claim about the integrated tree, established by a pinned verifier that runs
    // on Actions under every profile that requires one — `fresh` and `audited`
    // included, since a developer's own machine cannot attest to the merge tree
    // for it. The lane it unblocks can still be device-only, and only `driveLane`
    // knows not to spend an Actions run telling a connected device something it
    // already claimed over its heartbeat.
    if (body.accepted === true && stored.status === "applied") {
      const { snapshot: forDrive } = await readQueue(c.env, repositoryId, baseRef);
      await driveLane(c.env, deps, repositoryId, baseRef, forDrive);
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
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    // From the queue, not the projection.
    //
    // This picked whose turn to drive out of a read model that lags, so it could
    // dispatch for a pull request whose turn had already ended. Harmless, because
    // the merge workflow asks the queue itself and does nothing if the answer is
    // no — but it is a wasted run and the same habit that wedged the lane once
    // already. Reading the queue costs one row.
    //
    // Through `driveLane`, not `deps.driveTurn` directly, so a lane held under a
    // device-only profile is not pushed through Actions: the connected device
    // already claimed it over its heartbeat, and dispatching anyway spends a
    // whole run to be told there is nothing for it to do.
    // `driveLane` says who holds the lane, and this route reports what it said.
    //
    // The route used to decide that for itself, and looked only for `Offered`
    // or `Active`. An attempt that has returned its receipt is `Verifying`, so
    // the one lane in flight read as no lane at all: `LANE_IDLE` was answered
    // and `driveLane` — which does understand `Verifying` — was never reached.
    // Under `fresh` that is the whole window in which a merge still has to be
    // written, so the one operator tool for an unmerged attempt refused to look
    // at the only state it is ever stuck in. Two predicates for one question is
    // how that happened, so there is one now.
    const { snapshot } = await readQueue(c.env, repositoryId, baseRef);
    const outcome = await driveLane(c.env, deps, repositoryId, baseRef, snapshot);
    if (!outcome.dispatched) {
      return outcome.reason === "LANE_IDLE"
        ? c.json({ nudged: false, reason: outcome.reason })
        : c.json({ nudged: false, reason: outcome.reason, pullRequestNumber: outcome.pullRequestNumber });
    }
    const holder = snapshot.entries.find((e) => e.pullRequestNumber === outcome.pullRequestNumber);
    return c.json({ nudged: true, pullRequestNumber: outcome.pullRequestNumber, state: holder?.state ?? null });
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
      draft?: boolean;
      workReceiptDigest?: string;
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

    // The decision itself is not made here. It is the same walk the
    // `pull_request` webhook makes, and a route that held it privately is why
    // adopting the queue needed a workflow to call this at all.
    const result = await authorizeTurn(c.env, deps, onQueue, {
      repositoryId,
      baseRef,
      pullRequestNumber: body.pullRequestNumber,
      headSha: body.headSha,
      authorGithubUserId: String(body.authorGithubUserId ?? ""),
      draft: body.draft === true,
      prepare: body.prepare === true,
    });
    return c.json(authorizationResponse(result));
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
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    const who = c.get("caller");
    // The administrator of the organization that owns this repository, because
    // the gate has already established that this caller belongs to it. Read
    // before membership, `isAdmin` was a claim about whichever organization the
    // session had selected.
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
    const who = c.get("caller");
    // The administrator of the organization that owns this repository, because
    // the gate has already established that this caller belongs to it. Read
    // before membership, `isAdmin` was a claim about whichever organization the
    // session had selected.
    if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

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
        async ({ commands, store }) =>
          confirmOnly(commands, store, {
            attemptId,
            operationId: mergeOperationId(attemptId),
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

      // Confirming ends the attempt and frees the lane; the offer that follows
      // expires unclaimed in ninety seconds unless something drives it.
      await driveLane(c.env, deps, repositoryId, baseRef, recorded.snapshot ?? afterConfirm);

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
      const { result, snapshot } = await onQueue(c.env, repositoryId, baseRef, ({ commands, store }) => {
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

      // Ending the attempt frees the lane; the next offer expires unclaimed in
      // ninety seconds unless something drives it.
      await driveLane(c.env, deps, repositoryId, baseRef, snapshot);

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

    const { result: resolved, snapshot: afterNotMerged } = await onQueue(
      c.env,
      repositoryId,
      baseRef,
      async ({ commands }) =>
        commands.confirmNotMerged({
          idempotencyKey: `reconcile:${attemptId}:${reason.slice(0, 32)}`,
          attemptId,
          operationId: mergeOperationId(attemptId),
        }),
    );

    // Confirming not-merged frees the lane; the next offer expires unclaimed in
    // ninety seconds unless something drives it.
    await driveLane(c.env, deps, repositoryId, baseRef, afterNotMerged);

    return c.json({
      resolved: resolved.status,
      attemptId,
      actor: who.principalId,
      reason,
    });
  });

  /**
   * Record a merge the queue authorized, that landed, and that nobody wrote down.
   *
   * `reconcile` is the repair tool and it refuses unless an attempt still holds
   * the lane. The failure it exists for takes the lane away first: the queue read
   * GitHub before GitHub's read caught up with its own write, concluded
   * CONFIRMED_NOT_MERGED, and terminated the attempt. Four merges landed that
   * way and the chain has no link for any of them, and by the time anyone noticed
   * `reconcile` answered 409 for every one. A repair tool that only works while
   * the failure is still in progress is not a repair tool.
   *
   * So this needs nothing from the attempt. The signed merge intent is what
   * survives it, and it holds everything a transition record cites. The operator
   * supplies one thing, a commit sha, and every claim the record makes is read
   * from that commit or from the intent.
   *
   * Three things stop this writing a record for a merge nobody authorized.
   * The commit's tree and parents come from GitHub, never from the caller.
   * `authorizationFor` will only return an intent whose pinned tree and pinned
   * parents are exactly that commit's, so a commit the queue never pinned has
   * nothing to build a record from. And the transition record schema itself
   * refuses a record whose merged tree is not the candidate tree and whose first
   * and second parents are not the base and head the intent names, so a record
   * that got past the first two would not sign.
   *
   * Where the record goes is decided by the chain, not by when the merge
   * happened. The chain is hash-linked and append-only: a record's position and
   * the digest of the record before it are inside the bytes that were signed, so
   * putting a merge back where it belongs would mean re-signing every record
   * after it under new digests. That is a rewrite, and refusing to rewrite is the
   * whole claim. A repair links the current head and takes the next sequence, and
   * the chain then holds a record for the merge in an order that is not the order
   * it landed in.
   */
  app.post("/v1/queue/:repositoryId/repair", async (c) => {
    const who = c.get("caller");
    if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    const body = (await c.req.json().catch(() => ({}))) as {
      mergeSha?: string;
      reason?: string;
      /** Names the attempt where two of them authorized the same commit. */
      attemptId?: string;
    };
    if (typeof body.reason !== "string" || body.reason.trim().length < 8) {
      return c.json({ error: "a reason of at least 8 characters is required" }, 400);
    }
    if (typeof body.mergeSha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(body.mergeSha)) {
      return c.json({ error: "mergeSha required" }, 400);
    }
    const mergeSha = body.mergeSha;
    const reason = body.reason.trim();

    const recordFromIntentDeps = recordFromIntentDepsFor<TEnv>(deps, onQueue);
    const outcome = await recordMergeFromIntent(c.env, recordFromIntentDeps, {
      repositoryId,
      baseRef,
      mergeSha,
      witnessPrincipalId: who.principalId,
      ...(typeof body.attemptId === "string" ? { attemptId: body.attemptId } : {}),
    });

    if (outcome.status === "refused") {
      const status = outcome.code === "COMMIT_UNREADABLE" || outcome.code === "BASE_UNREADABLE" ? 404 : 409;
      return c.json({ error: outcome.detail, code: outcome.code }, status);
    }
    if (outcome.status === "already") {
      return c.json({
        recorded: "already",
        attemptId: outcome.attemptId,
        pullRequestNumber: outcome.pullRequestNumber,
        transitionDigest: outcome.transitionDigest,
      });
    }
    return c.json({
      recorded: "applied",
      attemptId: outcome.attemptId,
      pullRequestNumber: outcome.pullRequestNumber,
      mergeSha: outcome.mergeSha,
      sequence: outcome.sequence,
      transitionDigest: outcome.transitionDigest,
      mergeIntentDigest: outcome.mergeIntentDigest,
      actor: who.principalId,
      reason,
    });
  });

  /**
   * What is wrong with this branch's chain, and what thwip would do about it.
   *
   * Read-only, and it exists so that reading a finding is not the start of an
   * afternoon in D1. The heartbeat has reported these findings since the day
   * the first unrecorded merge was understood, and a finding on its own leaves
   * a person to list the merge intents, ask GitHub about every commit in the
   * gap, compare trees and parent vectors, and work out which attempt
   * authorized which commit. The queue holds both halves of every one of those
   * comparisons, so it does the search and says what it found.
   *
   * The same verification the tick runs and the same one an outside reader runs
   * against the published chain. A remedy computed from a different reading of
   * the chain than the one that reported the problem would be a remedy for a
   * different problem.
   */
  app.get("/v1/queue/:repositoryId/heal", async (c) => {
    const who = c.get("caller");
    if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    const plans = await healPlans(c.env, deps, repositoryId, baseRef);
    if ("error" in plans) return c.json({ error: plans.error }, 404);
    return c.json({ findings: plans.plans });
  });

  /**
   * Answer one finding.
   *
   * The administrator names the finding and says why, and nothing else. No
   * tree, no parent vector, no commit sha: the finding names the two ends of
   * the gap, the commits in between come from GitHub, and which of them a merge
   * record may be written for is decided by whether a signed intent pins that
   * tree on those parents. An operator who could name the commit could name the
   * throwaway merge GitHub computes for an open pull request, which is how
   * record 54 reached the chain.
   *
   * The plan is recomputed here from a fresh verification rather than accepted
   * from the caller, so a heal cannot answer a gap that has closed, or a gap
   * that never existed.
   *
   * Where two attempts authorize one commit this refuses and names both. There
   * is no flag that makes it choose, because choosing would be a guess wearing
   * a signature.
   */
  app.post("/v1/queue/:repositoryId/heal", async (c) => {
    const who = c.get("caller");
    if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    const body = (await c.req.json().catch(() => ({}))) as { finding?: string; code?: string; reason?: string };
    if (typeof body.reason !== "string" || body.reason.trim().length < 8) {
      return c.json({ error: "a reason of at least 8 characters is required" }, 400);
    }
    if (typeof body.finding !== "string" || !/^sha256:[0-9a-f]{64}$/.test(body.finding)) {
      return c.json({ error: "finding required: the digest the finding was reported at" }, 400);
    }
    // The digest names the record the finding was reported at, and one record
    // can be reported at for more than one reason: a link can name the wrong
    // predecessor and begin somewhere the record before it did not end. So the
    // digest alone does not name a finding, and picking by it could carry out
    // the remedy for the other one against a chain that keeps whatever it is
    // given.
    if (typeof body.code !== "string" || body.code.length === 0) {
      return c.json({ error: "code required: the finding's code, because one record can carry two" }, 400);
    }
    const reason = body.reason.trim();

    const plans = await healPlans(c.env, deps, repositoryId, baseRef);
    if ("error" in plans) return c.json({ error: plans.error }, 404);
    const plan = plans.plans.find((p) => p.digest === body.finding && p.code === body.code);
    if (plan === undefined) {
      return c.json({ error: "this branch's chain has no such finding", code: "NO_SUCH_FINDING" }, 404);
    }

    const outcome = await applyHeal(c.env, recordFromIntentDepsFor<TEnv>(deps, onQueue), {
      repositoryId,
      baseRef,
      plan,
      actorPrincipalId: who.principalId,
      reason,
    });
    if (outcome.status === "refused") {
      return c.json({ error: outcome.detail, code: outcome.code, steps: plan.steps }, 409);
    }
    return c.json({
      healed: "applied",
      finding: plan.digest,
      wrote: outcome.wrote,
      actor: who.principalId,
      reason,
    });
  });

  /**
   * Correct a record that names a sha the branch does not have.
   *
   * Record 54 says pull request 107's merge left the base at the throwaway test
   * merge GitHub computes for an open pull request. Main took a different commit
   * with the same tree and the same parents. The cause is fixed; the record is
   * not, and cannot be: its digest is the next record's predecessor and six
   * records chain from it, so editing the bytes means re-signing seven records
   * under new digests. That replaces the chain rather than repairing it, and
   * refusing to replace it is the product.
   *
   * So the correction is appended. `verifyChain` follows the corrected edge in
   * place of the original, and the original stays served, signed, and saying
   * what it said.
   *
   * A correction that could be applied to any record is a licence to rewrite the
   * past, which is worse than the bug. Four things hold the line, and none of
   * them is the operator's word:
   *
   * 1. The record must actually be wrong, and GitHub says so. `baseContainsSha`
   *    is asked whether the branch contains the sha the record names, and a
   *    `true` is refused: a record whose sha is on the branch has nothing wrong
   *    with it, whatever an administrator believes. A branch that cannot be
   *    asked is refused too, because signing an unchecked claim is exactly what
   *    produced record 54.
   * 2. The sha it is corrected to must be on the branch, asked the same way.
   * 3. That commit must be the same commit under another name. Its tree and its
   *    parent vector come from GitHub and have to equal the ones the record
   *    already certified, so no correction can reach a commit that integrates a
   *    different tree or joins a different history.
   * 4. Everything the record repeats is copied from the record, not supplied:
   *    `before`, the tree, the parents, the attempt. The operator supplies a
   *    digest, a sha and a reason, and the reason is the only free text.
   *
   * The verifier re-checks 3 and 4 from the bytes alone, so a chain served to an
   * outside reader does not rest on this route having been honest. What it
   * cannot re-check is 1 and 2, which need GitHub. The residue is stated in the
   * report: a holder of the signing key could rename a merge commit to a
   * different commit with the same tree, the same parents and the same starting
   * point, and only where the branch really does contain the second and not the
   * first — which is to say, only where the branch itself already says so.
   */
  app.post("/v1/queue/:repositoryId/correct", async (c) => {
    const who = c.get("caller");
    if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId, baseRef } = selected;

    const body = (await c.req.json().catch(() => ({}))) as {
      transitionDigest?: string;
      mergeSha?: string;
      reason?: string;
    };
    if (typeof body.reason !== "string" || body.reason.trim().length < 8) {
      return c.json({ error: "a reason of at least 8 characters is required" }, 400);
    }
    if (typeof body.transitionDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(body.transitionDigest)) {
      return c.json({ error: "transitionDigest required" }, 400);
    }
    if (typeof body.mergeSha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(body.mergeSha)) {
      return c.json({ error: "mergeSha required" }, 400);
    }
    const reason = body.reason.trim();
    const mergeSha = body.mergeSha;
    const correctsDigest = body.transitionDigest;

    const db = c.env.DB as unknown as D1Like;
    // From the chain this branch serves, not from the attestation table at
    // large: a correction may only reach a record a reader of this chain can
    // read, so that the substitution it asks for is one they can check.
    const chain = await readChain(db, repositoryId, baseRef);
    const link = chain.find((l) => l.digest === correctsDigest);
    if (link === undefined) return c.json({ error: "this branch's chain does not serve that record" }, 404);

    const parsed = parseTransitionRecord(JSON.parse(new TextDecoder().decode(link.bytes)) as unknown);
    if (!parsed.ok) return c.json({ error: `that record does not parse: ${parsed.detail}` }, 409);
    const corrected = parsed.value;
    const attemptId = correctedAttemptId(corrected);
    if (attemptId === null) {
      return c.json(
        { error: `a ${corrected.kind} record cites no attempt and cannot be corrected`, code: "NOT_CORRECTABLE" },
        409,
      );
    }
    if (corrected.before.baseSha === null || corrected.before.treeOid === null) {
      return c.json({ error: "a record that opens an epoch cannot be corrected", code: "NOT_CORRECTABLE" }, 409);
    }

    // The gate. A record whose sha the branch contains is a record that is
    // right, and no reason an operator can write changes that.
    const recordedOnBase = await deps.baseContainsSha(c.env, repositoryId, baseRef, corrected.after.baseSha);
    if (recordedOnBase === null) {
      return c.json(
        {
          error: `${baseRef} could not be asked whether it contains ${corrected.after.baseSha}`,
          code: "RECORD_BASE_UNREADABLE",
        },
        409,
      );
    }
    if (recordedOnBase) {
      return c.json(
        {
          error: `${baseRef} contains ${corrected.after.baseSha}; that record says nothing untrue`,
          code: "RECORD_BASE_ON_BRANCH",
        },
        409,
      );
    }

    const onBase = await deps.baseContainsSha(c.env, repositoryId, baseRef, mergeSha);
    if (onBase !== true) {
      return c.json(
        {
          error:
            onBase === false
              ? `${baseRef} does not contain ${mergeSha}`
              : `${baseRef} could not be asked whether it contains ${mergeSha}`,
          code: "MERGE_NOT_ON_BASE",
        },
        409,
      );
    }

    // The same commit under another name, or nothing. GitHub describes it; the
    // record it corrects says what that description has to be.
    const facts = await deps.commitFacts(c.env, repositoryId, mergeSha);
    if (facts === null) return c.json({ error: "could not read that commit" }, 404);
    const sameCommit =
      facts.treeOid === corrected.after.treeOid &&
      corrected.after.parentsComplete &&
      facts.parentShas.length === corrected.after.parentCount &&
      facts.parentShas.every((sha, i) => sha === corrected.after.parentOids[i]);
    if (!sameCommit) {
      return c.json(
        {
          error:
            `${mergeSha} carries tree ${facts.treeOid} over parents ${facts.parentShas.join(", ")}; ` +
            `record ${corrected.transitionSequence} certified tree ${corrected.after.treeOid} over ` +
            `${corrected.after.parentOids.join(", ")}`,
          code: "CORRECTION_NOT_THE_SAME_COMMIT",
        },
        409,
      );
    }

    // One correction per record, held by the database rather than by this read:
    // the partial unique index on attempt_id refuses a second row that claims a
    // position, so two callers racing cannot both write one.
    const correctionKey = `correction:${correctsDigest}`;
    const already = await transitionRecordFor(db, repositoryId, baseRef, correctionKey);
    if (already !== null) {
      return c.json({ corrected: "already", corrects: correctsDigest, transitionDigest: already });
    }

    const { snapshot } = await readQueue(c.env, repositoryId, baseRef);
    const head = snapshot.transitions.at(-1);
    const transitionSequence = (head?.transitionSequence ?? 0) + 1;
    const priorDigest = (head?.digest ?? null) as Sha256 | null;
    if (priorDigest === null) return c.json({ error: "there is no chain to append to" }, 409);

    const document = await buildBaseCorrectionRecord({
      repositoryId,
      baseRef,
      queueEpoch: snapshot.queueEpoch,
      transitionSequence,
      previousTransitionDigest: priorDigest,
      corrected: {
        digest: correctsDigest as Sha256,
        transitionSequence: corrected.transitionSequence,
        before: { baseSha: corrected.before.baseSha, treeOid: corrected.before.treeOid },
        after: corrected.after,
        attemptId,
      },
      baseSha: mergeSha,
      actorPrincipalId: who.principalId,
      reason,
      observedAt: new Date().toISOString(),
    });
    const signed = await signTransitionRecord(document, {
      sign: (bytes, typ) => deps.signRecordBytes(c.env, bytes, typ),
    });
    if ("error" in signed) {
      return c.json({ error: `the queue refused to sign its own record: ${signed.error}` }, 409);
    }

    const policy = await deps.activePolicy(c.env, repositoryId);
    const stored = await storeAttestation(db, {
      digest: signed.digest,
      kind: "base-correction",
      repositoryId,
      baseRef,
      transitionSequence,
      attemptId: correctionKey,
      bytes: signed.bytes,
      jws: signed.jws,
      ...(policy === null
        ? {}
        : {
            organizationId: policy.organizationId,
            mirror: (mirrored: {
              organizationId: string;
              repositoryId: string;
              kind: "merge-intent" | "transition-record";
              digest: string;
              bytes: Uint8Array;
            }) =>
              storeEvidence(c.env, {
                organizationId: mirrored.organizationId,
                repositoryId: mirrored.repositoryId,
                kind: mirrored.kind,
                digest: mirrored.digest as `sha256:${string}`,
                bytes: mirrored.bytes,
              }).then(() => undefined),
          }),
    });
    if (!stored.stored) {
      return c.json({ corrected: "already", corrects: correctsDigest, transitionDigest: stored.digest });
    }

    const { result } = await onQueue(c.env, repositoryId, baseRef, ({ commands, store }) => {
      const tail = store.state().transitions.at(-1);
      if ((tail?.transitionSequence ?? 0) + 1 !== transitionSequence || (tail?.digest ?? null) !== priorDigest) {
        return { moved: true as const };
      }
      return {
        moved: false as const,
        transition: commands.recordTransition({
          idempotencyKey: `correct:${correctsDigest}`,
          kind: "correction",
          transitionSequence,
          priorDigest,
          digest: signed.digest,
          // Where the branch really went, which is the whole claim.
          baseSha: mergeSha,
          attemptId: null,
          witnessPrincipalIds: [who.principalId],
        }),
      };
    });

    if (result.moved) {
      await db
        .prepare("UPDATE queue_attestations SET transition_sequence = NULL WHERE digest = ?")
        .bind(signed.digest)
        .run();
      return c.json(
        { error: "the chain moved while this record was being signed; try again", code: "CHAIN_MOVED" },
        409,
      );
    }

    return c.json({
      corrected: result.transition.status,
      corrects: correctsDigest,
      correctsSequence: corrected.transitionSequence,
      correctedBaseSha: corrected.after.baseSha,
      baseSha: mergeSha,
      sequence: transitionSequence,
      transitionDigest: signed.digest,
      actor: who.principalId,
      reason,
    });
  });

  /**
   * Report that an authorized merge did not happen.
   *
   * Without this the lane stays held: the operation was persisted before the write,
   * the write was refused, and the queue is left reconciling until an operator
   * intervenes.
   *
   * The caller's word is not enough on its own. A merge run reports what one read
   * of GitHub told it, and GitHub's reads lag GitHub's own writes: pull request
   * 105 merged at 16:41:38 and read back as unmerged at 16:41:39, which is how a
   * merge that is on main came to be recorded as CONFIRMED_NOT_MERGED with no
   * transition record behind it. So the queue confirms the negative itself,
   * across several reads and against git ancestry, before writing it down.
   * Anything it cannot confirm is unknown, and unknown reconciles.
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

    const evidence = await confirmAbsenceFor(c.env, deps, repositoryId, baseRef, attemptId);
    if (evidence.kind !== "not-merged") {
      // Not a refusal the queue can stand behind. The attempt goes to
      // reconciliation, which reads rather than writes and can still end in a
      // confirmed merge with a record behind it.
      const { snapshot: reconciling } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) =>
        commands.mergeOutcomeUnknown({ idempotencyKey: `not-merged:unknown:${attemptId}`, attemptId }),
      );
      await driveLane(c.env, deps, repositoryId, baseRef, reconciling);
      return c.json({
        resolved: "reconciling",
        reason: evidence.reason,
        detail: body.detail ?? null,
        note: "the queue could not confirm that this merge did not happen",
      });
    }

    const resolution = await resolveNotMerged(c.env, { repositoryId, baseRef, attemptId, operationId });
    const resolved = { status: resolution.status };
    const snapshot = resolution.snapshot;

    // This is the path a losing merge run takes when GitHub refuses the merge.
    // Confirming not-merged frees the lane, and the next offer expires unclaimed
    // in ninety seconds unless something drives it — this is how the lane was
    // freed without being driven in production.
    await driveLane(c.env, deps, repositoryId, baseRef, snapshot);

    return c.json({ resolved: resolved.status, detail: body.detail ?? null });
  });

  /**
   * Report the merge the queue authorized. The write happens in CI because the App
   * cannot yet merge, so the queue must be told which commit landed, and it refuses
   * anything that is not the candidate it authorized. That refusal is the guard that
   * makes delegating the write safe.
   *
   * A commit id is the whole report. The tree and the parents come from GitHub
   * here, so the caller names the commit and the queue reads it.
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
      sponsorPrincipalId?: string;
    };
    const baseRef = branchRef(body.baseRef);
    if (baseRef === null) return c.json({ error: "baseRef must name a branch" }, 400);
    for (const [name, value] of [
      ["attemptId", body.attemptId],
      ["operationId", body.operationId],
      ["mergeSha", body.mergeSha],
    ] as const) {
      if (typeof value !== "string" || value.length === 0) return c.json({ error: `${name} required` }, 400);
    }

    const attemptId = body.attemptId!;
    const mergeSha = body.mergeSha!;

    const outcome = await recordLandedMerge(c.env, {
      repositoryId,
      baseRef,
      attemptId,
      operationId: body.operationId!,
      mergeSha,
      witnessPrincipalIds: body.sponsorPrincipalId === undefined ? [] : [body.sponsorPrincipalId],
    });
    if (!outcome.ok) {
      // A merge the queue cannot describe is not recorded. Falling back to what
      // the caller said would put the trust back where this took it from, and
      // the attempt stays open for reconciliation to settle from its own reads.
      return c.json(
        { error: outcome.detail, code: outcome.code },
        outcome.code === "MERGE_UNREADABLE" ? 404 : 409,
      );
    }

    await driveLane(c.env, deps, repositoryId, baseRef, outcome.snapshot);
    return c.json({
      merged: true,
      confirmed: outcome.confirmed,
      transition: outcome.transition,
      sequence: outcome.sequence,
      transitionDigest: outcome.digest,
      // Said plainly when a link could not be built, because a chain short by
      // one is something an operator has to be able to see.
      detail: outcome.detail,
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
   * Why one turn went to the pull request it went to (plan.md §21.2).
   *
   * This is the record every assignment and every `TurnOffered` binds by digest,
   * and until it could be fetched the binding proved nothing. The bytes are
   * verified against the digest that names them and then read through the same
   * validator a device would use, so the answer is a decision that survives its
   * own consistency checks or an explicit refusal. Nothing here is derived from
   * live queue state: the record says what the scheduler could see when it
   * chose, which is the only question it can honestly answer later.
   *
   * A decision names pull request numbers and the principals in the round, so
   * read access to the repository is required. There is no public form of it.
   */
  app.get("/v1/queue/:repositoryId/decisions/:digest", async (c) => {
    const selected = requestedQueue(c);
    if ("error" in selected) return c.json({ error: selected.error }, 400);
    const { repositoryId } = selected;

    const digest = c.req.param("digest");
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return c.json({ error: "not a digest" }, 400);

    const who = await deps.authenticate(c, c.env);
    if (!who.ok) return c.json({ error: "unauthorized" }, who.status);
    const level = await repositoryAccess(c.env.DB as unknown as D1Like, repositoryId, who);
    if (!atLeast(level, "read")) return c.json({ error: REPOSITORY_FORBIDDEN }, 403);

    if (c.env.EVIDENCE === undefined) {
      return c.json({ error: "NO_EVIDENCE_STORE", detail: "this deployment archives no decisions" }, 503);
    }
    const organizationId = await c.env.DB.prepare(
      "SELECT organization_id AS id FROM projects WHERE github_repository_id = ?",
    )
      .bind(repositoryId)
      .first<{ id: string }>();
    if (organizationId === null) return c.json({ error: "no queue for that repository" }, 404);

    const found = await getEvidence(c.env.EVIDENCE as unknown as R2Like, {
      organizationId: organizationId.id,
      repositoryId,
      kind: "queue-decision",
      digest: digest as Sha256,
    });
    if (!found.found) {
      const status = found.reason === "MISSING" ? 404 : 409;
      return c.json({ error: found.reason, detail: "no decision with that digest was stored" }, status);
    }

    const decoded = new TextDecoder().decode(found.bytes);
    let body: unknown;
    try {
      body = JSON.parse(decoded);
    } catch {
      return c.json({ error: "DECISION_UNREADABLE", detail: "the stored bytes are not JSON" }, 409);
    }
    const decision = parseQueueDecision(body);
    if (!decision.ok) {
      return c.json({ error: "DECISION_INVALID", detail: decision.detail }, 409);
    }
    return c.json({ digest, decision: decision.value, record: decoded });
  });

  /**
   * A branch's whole chain, with the bytes each link was signed over.
   *
   * Open only when the project has said so. A chain names pull request
   * numbers, head and base SHAs, tree oids, actor GitHub ids and free-text
   * override reasons — public for a public repository, and nobody else's
   * business for a private one. A caller cannot make it public just by
   * knowing the numeric repository id, so a private project is served only to
   * a member of the organization that owns the repository.
   *
   * Nothing about the project is disclosed before that decision. The 404 for
   * an unknown branch used to come out first, which let a caller with no
   * session walk the numeric repository id space, read 404 against 401, and
   * learn which private repositories are onboarded and which base refs they
   * queue. A caller who has not proved membership now gets the same answer
   * either way, and the 404 waits until it is a member asking.
   */
  app.get("/v1/queue/:repositoryId/chain", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    if (repositoryId === null) {
      return c.json({ error: "the repository id must be GitHub's numeric repository id" }, 400);
    }

    const asked = c.req.query("ref");
    let baseRef = asked === undefined ? null : branchRef(asked);
    if (asked !== undefined && baseRef === null) {
      return c.json({ error: "ref must name a branch, like refs/heads/main" }, 400);
    }

    if (baseRef === null) {
      // A published chain resolves its own branch, so an outside verifier does
      // not have to be told the spelling before it can read the record.
      //
      // Only a published one. Resolving for an unpublished chain would answer
      // "does this private repository use the queue" to anyone who asked, which
      // is the enumeration the 404 further down exists to prevent.
      const published = await c.env.DB.prepare(
        "SELECT base_ref AS baseRef FROM queue_projects WHERE github_repository_id = ? AND chain_public = 1",
      )
        .bind(repositoryId)
        .all<{ baseRef: string }>();
      const branches = published.results ?? [];
      if (branches.length !== 1) {
        return c.json({ error: "name the branch with ?ref=refs/heads/<branch>" }, 400);
      }
      baseRef = branches[0]!.baseRef;
    }

    const project = await c.env.DB.prepare(
      "SELECT attested_from_sequence AS epoch, chain_public AS chainPublic FROM queue_projects WHERE github_repository_id = ? AND base_ref = ?",
    )
      .bind(repositoryId, baseRef)
      .first<{ epoch: number; chainPublic: number }>();

    if (project === null || project.chainPublic !== 1) {
      const who = await deps.authenticate(c, c.env);
      if (!who.ok) return c.json({ error: "unauthorized" }, who.status);
      const level = await repositoryAccess(c.env.DB as unknown as D1Like, repositoryId, who);
      if (!atLeast(level, "read")) return c.json({ error: REPOSITORY_FORBIDDEN }, 403);
    }
    if (project === null) return c.json({ error: "no queue for that branch" }, 404);

    const links = await readChain(c.env.DB as unknown as D1Like, repositoryId, baseRef);
    const decoder = new TextDecoder();
    return c.json({
      epochStartsAt: project.epoch,
      links: links.map((l) => ({ digest: l.digest, sequence: l.sequence, record: decoder.decode(l.bytes), jws: l.jws })),
    });
  });

  return app;
}

