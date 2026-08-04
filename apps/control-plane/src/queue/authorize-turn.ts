import type { QueueRouteEnv } from "./routes.js";
import type { D1Like } from "./projection.js";
import { admit, buildSnapshot, walkToMergeReady, type QueueSnapshot } from "./queue-operations.js";
import { loadQueueState } from "./queue-state.js";
import { capabilityFor, requiresDeviceOnly } from "./runners.js";
import {
  deriveReadiness,
  foldCapability,
  nonThwipCheckState,
  reviewGates,
  type PlatformHealth,
  type PullRequestGates,
  type ReadinessFacts,
} from "./readiness.js";
import { nextAction, unplaceableUpdate, type TurnCheckUpdate } from "./turn-check.js";
import { proofBindingFrom, proofShortfall, workReceiptDigestFrom } from "./work-receipt.js";
import { unsatisfiedRequiredChecks, type RequiredCheckState } from "./github-port.js";
import type { CandidateStateReason, IntegratedCandidate } from "./candidate.js";
import {
  reuseEvidenceFor,
  signReusedIntent,
  signVerifiedIntent,
  storeAttestation,
  verifiedEvidenceFor,
} from "./attestation.js";
import { mergeOperationId } from "./merge-commit.js";
import { requiredSuitesDigest, type Sha256 } from "@thwip/queue-protocol";
import { decideCandidate, requiresRemoteVerification } from "./candidate-verdict.js";
import { localRunEvidenceFor } from "./local-run-gate.js";
import { headProofAccepted } from "./head-proof.js";
import { candidateVerdict as readCandidateVerdict, claimCandidateDispatch } from "./candidate-store.js";
import {
  storeEvidence,
  type ActivePolicy,
  type MergeLaneDeps,
  type OnQueue,
} from "./merge-lane.js";
import type { BlockingReason } from "@thwip/queue-domain";

/**
 * How long a dispatched verifier may stay silent before another is asked for. A
 * run that dies without reporting must not wedge its candidate forever.
 */
const CANDIDATE_DISPATCH_STALE_MS = 15 * 60_000;

/**
 * What the queue has to read, and who it may ask, to walk one pull request from
 * "asked" to "a merge has been written".
 *
 * Every one of these is an installation-token read the App already makes. They
 * were reachable only from inside the `/authorize` handler, which is why the
 * `pull_request` webhook could enqueue a pull request and never take it any
 * further: the walk lived in a route, so only a caller holding an Actions OIDC
 * token could reach it.
 */
export interface AuthorizeTurnDeps<TEnv extends QueueRouteEnv> extends MergeLaneDeps<TEnv> {
  /** Queue configuration for a branch, or null when the branch has no queue. */
  queueProject(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
  ): Promise<{ activationState: string } | null>;
  /** The activated principal for a GitHub user id, or null. */
  principalFor(env: TEnv, githubUserId: string): Promise<string | null>;
  /**
   * What GitHub says a pull request is, for a caller holding only its number.
   *
   * Author, base branch, bot-ness, draft and head, all from the one read. The
   * first three settle who the turn belongs to and which queue the entry is on.
   * The last two are what a caller that did not arrive on a `pull_request`
   * delivery has no other way to know, and guessing either of them admits a
   * draft or walks a head that has moved.
   */
  pullRequestPlacement(
    env: TEnv,
    repositoryId: string,
    pullRequestNumber: number,
  ): Promise<{
    authorGithubUserId: string;
    baseRef: string;
    authorIsBot: boolean;
    draft: boolean;
    headSha: string;
  } | null>;
  /** Publish whose turn it is, as a check GitHub can require. */
  publishTurnCheck?(env: TEnv, repositoryId: string, update: TurnCheckUpdate): Promise<void>;
  /** The integrated candidate GitHub has computed for a pull request. */
  integratedCandidate?(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
    pullRequestNumber: number,
  ): Promise<IntegratedCandidate | null>;
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
      requiredSuites: readonly string[];
    },
  ): Promise<{ ok: true } | { ok: false; status: number; detail: string }>;
  /** What the branch requires of a head, and what the head says about it. */
  requiredCheckState?(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
    headSha: string,
  ): Promise<RequiredCheckState | null>;
  /** Whether the repository is still the one this queue's policy assumes. */
  platformHealth?(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
    sponsorGithubUserId: string,
  ): Promise<PlatformHealth | null>;
  /** What GitHub's own pull-request rule asks of this pull request. */
  pullRequestGates?(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
    pullRequestNumber: number,
    headSha: string,
  ): Promise<PullRequestGates | null>;
}

/** One pull request's ask, from whichever caller is asking. */
export interface TurnRequest {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly authorGithubUserId: string;
  readonly draft: boolean;
}

/** What the queue decided about one ask. */
export type TurnAuthorization =
  | { readonly outcome: "not-configured" }
  | {
      readonly outcome: "refused";
      readonly activationState: string;
      readonly reason: string;
      /** Null where the reason carries its own next action and needs no sentence. */
      readonly detail: string | null;
      readonly entryId: string;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly outcome: "verification-requested";
      readonly activationState: string;
      readonly enforcing: boolean;
      readonly entryId: string;
    }
  | {
      readonly outcome: "settled";
      readonly activationState: string;
      readonly enforcing: boolean;
      readonly authorized: boolean;
      readonly reason: string;
      readonly entryId: string;
      readonly operationId: string | null;
      readonly queuePosition: number;
    };

/**
 * The answer a check reads, from the decision the queue took.
 *
 * One serializer for one decision, so the route's body and whatever else acts
 * on the same answer cannot describe different states.
 */
export function authorizationResponse(result: TurnAuthorization): Record<string, unknown> {
  switch (result.outcome) {
    case "not-configured":
      return { authorized: true, reason: "QUEUE_NOT_CONFIGURED", enforcing: false };
    case "refused":
      return {
        authorized: false,
        enforcing: true,
        activationState: result.activationState,
        reason: result.reason,
        detail: result.detail,
        entryId: result.entryId,
        operationId: null,
        ...(result.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: result.retryAfterSeconds }),
      };
    case "verification-requested":
      return {
        authorized: true,
        enforcing: result.enforcing,
        activationState: result.activationState,
        reason: "HOLDS_TURN",
        candidate: "verification-requested",
        entryId: result.entryId,
        operationId: null,
        retryAfterSeconds: 20,
      };
    case "settled":
      return {
        authorized: result.authorized,
        enforcing: result.enforcing,
        activationState: result.activationState,
        reason: result.reason,
        entryId: result.entryId,
        operationId: result.operationId,
        queuePosition: result.queuePosition,
      };
  }
}

/**
 * Walk one pull request as far as this ask can take it.
 *
 * Enqueue it, decide whether it is ready, tick the scheduler, claim the offer,
 * and — for the caller that is about to write — walk the held attempt to a
 * signed merge intent and perform the write. Every GitHub read on that walk is
 * made here, from the App's own installation token, so the caller is never the
 * source of a fact the queue signs against.
 */
async function walkTurn<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: AuthorizeTurnDeps<TEnv>,
  onQueue: OnQueue<TEnv>,
  input: TurnRequest,
  appWillWrite: boolean,
): Promise<TurnAuthorization> {
  const { repositoryId, baseRef } = input;
  const project = await deps.queueProject(env, repositoryId, baseRef);
  if (project === null) {
    // Not a queue branch: the check must not start failing because a queue was
    // never configured here.
    return { outcome: "not-configured" };
  }

  const entryId = `entry_${repositoryId}_${input.pullRequestNumber}`;
  const db = env.DB as unknown as D1Like;

  // Whose turn this is.
  //
  // One question, one answer: the scheduler offers the turn to the entry's
  // sponsor, and the machine this gate waits for has to belong to the same
  // person. This used to read presence for the pull request's author while the
  // offer went to the sponsor, so wherever the two differed a `fresh` queue
  // waited on a laptop belonging to somebody who was never going to run the
  // turn.
  //
  // The author derives the sponsor and nothing else, and only where there is
  // no entry yet to have a sponsor. One extra row read against the document
  // this route is about to open anyway, which is the same trade the heartbeat
  // route already makes to avoid a write.
  const placed = (await loadQueueState(db, repositoryId, baseRef)).store.state().entries.get(entryId);
  const sponsorPrincipalId =
    placed?.sponsorPrincipalId ?? (await deps.principalFor(env, String(input.authorGithubUserId ?? "")));
  const sponsorGithubUserId = placed?.sponsorGithubUserId ?? String(input.authorGithubUserId ?? "");

  // Why there is nobody, when there is nobody.
  //
  // A bot author and an unactivated person both leave the queue with no
  // sponsor, and they need different things done about them: one is cleared
  // by a colleague joining the queue, the other by whoever runs the
  // installation. Read only in that case, so an ordinary ask spends no GitHub
  // request on it. Unknown stays unknown.
  const unsponsored =
    sponsorPrincipalId === null
      ? await deps
          .pullRequestPlacement(env, repositoryId, input.pullRequestNumber)
          .catch(() => null)
      : null;
  const unplaceableReason = unsponsored?.authorIsBot === true ? "SPONSOR_REQUIRED" : null;

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
  if (sponsorPrincipalId === null && deps.publishTurnCheck !== undefined) {
    try {
      await deps.publishTurnCheck(
        env,
        repositoryId,
        unplaceableUpdate({
          entryId,
          pullRequestNumber: input.pullRequestNumber,
          headSha: input.headSha,
          reason: unplaceableReason,
        }),
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
  //
  // Captured after validation: TypeScript discards the narrowing inside a
  // closure, and re-checking would be checking the same thing twice.
  const pullRequestNumber = input.pullRequestNumber;
  const headSha = input.headSha;

  // Read once and used everywhere below. The profile decides whether a runner
  // has to be connected, whether the server may take the offer for itself, and
  // what evidence the merge rests on, and three reads of it could disagree.
  const policy = await deps.activePolicy(env, repositoryId);
  const deviceOnly = requiresDeviceOnly(policy?.securityProfile ?? null);

  // Through `deriveReadiness`, from the facts this route has read.
  //
  // It used to be two expressions here and two more in the pull-request
  // webhook, each naming a couple of reasons out of the twenty the derivation
  // knows. Neither copy consulted the ruleset, the App's permissions or the
  // sponsor's access, so three reason codes with sentences on every surface
  // described a state nothing ever checked for.
  //
  // Every field is stated, because the permissive constant this used to spread
  // meant a field nobody thought about was silently no objection. A fact this
  // route cannot answer says `"unread"` rather than a value that reads as
  // fine, so a reviewer can tell the difference.
  //
  // Capability is left out and folded below: `foldCapability` is where runner
  // presence is decided for every writer of `schedulerEligible`.
  const stated: ReadinessFacts = {
    draft: input.draft,
    // The three that cost a GitHub read each. They are read on the walk to a
    // merge, below, where one merge's worth is the right price for them.
    ownerAuthorized: "unread",
    appPermissionsHealthy: "unread",
    rulesetEnforced: "unread",
    authorIsBot: unsponsored === null ? "unread" : unsponsored.authorIsBot,
    sponsorPrincipalId,
    // Read, never asserted. This was `proofAccepted` off the request body,
    // which a workflow living in the branch under test composed, so the one
    // fact the product exists to establish was claimed by the thing being
    // checked. The App verified the proof itself and stored the verdict.
    headProof: (await headProofAccepted(db, repositoryId, headSha)) ? "accepted" : "missing",
    proofShortfall: "unread",
    reviewsSatisfied: "unread",
    codeOwnerReviewSatisfied: "unread",
    approvalAfterPushSatisfied: "unread",
    conversationsResolved: "unread",
    nonThwipChecks: "unread",
    mergeable: "unread",
  };

  // What GitHub says about this head and this pull request, before the entry
  // is called ready.
  //
  // Five facts had no writer. Both callers spread a permissive constant, so
  // `REQUIRED_CHECK_FAILED`, `REQUIRED_CHECK_PENDING`, `REVIEW_REQUIRED`,
  // `CODEOWNER_REVIEW_REQUIRED`, `APPROVAL_AFTER_PUSH_REQUIRED`,
  // `CONVERSATION_UNRESOLVED`, `MERGE_CONFLICT` and `POLICY_CHANGED` were all
  // unreachable. A pull request with red CI, or with no approval, read as
  // ready: it took a turn, ran on somebody's machine, collected a signed merge
  // intent, and then GitHub refused the merge on facts that were readable
  // before the offer ever went out.
  //
  // Read only when nothing else already blocks the entry, so a blocked pull
  // request asking once a minute costs no GitHub reads and each read happens
  // where it can change the answer. The walk below reuses these answers rather
  // than asking again, so the two gates cannot disagree about one head.
  // Unknown is not a refusal, in every one of them.
  const clear = deriveReadiness(stated).ready;
  const branchChecks =
    !clear || deps.requiredCheckState === undefined
      ? null
      : await deps.requiredCheckState(env, repositoryId, baseRef, headSha).catch(() => null);
  const gates =
    !clear || deps.pullRequestGates === undefined
      ? null
      : await deps
          .pullRequestGates(env, repositoryId, baseRef, pullRequestNumber, headSha)
          .catch(() => null);
  const review = gates === null ? null : reviewGates(gates.review);
  // What the head's proof does not cover of the policy in force. The merge
  // gate makes the same two comparisons when it assembles the evidence, by
  // which point the pull request has spent its turn; here the developer reads
  // it first. No active policy means nothing to compare, so no read is spent.
  const headCommit =
    !clear || policy === null ? null : await deps.commitFacts(env, repositoryId, headSha).catch(() => null);

  const facts: ReadinessFacts = {
    ...stated,
    proofShortfall:
      headCommit === null
        ? "unread"
        : proofShortfall(
            headCommit.message === undefined ? null : proofBindingFrom(headCommit.message),
            policy,
          ),
    reviewsSatisfied: review?.reviewsSatisfied ?? "unread",
    codeOwnerReviewSatisfied: review?.codeOwnerReviewSatisfied ?? "unread",
    approvalAfterPushSatisfied: review?.approvalAfterPushSatisfied ?? "unread",
    conversationsResolved: review?.conversationsResolved ?? "unread",
    nonThwipChecks: branchChecks === null ? "unread" : nonThwipCheckState(branchChecks),
    mergeable: gates === null ? "unread" : gates.mergeable,
  };
  const base = deriveReadiness(facts);
  const baseReady = base.ready;
  const basePrimaryReason: BlockingReason | null = base.primaryReason;

  // Runner presence has to be read before the transaction, not inside it:
  // `onQueue`'s callback runs synchronously against the open store, and this
  // is a network round trip. Skipped entirely when there is no sponsor — there
  // is nobody to be connected — and when the profile has no device-only
  // requirement, `capabilityFor` never touches `queue_runners` at all.
  const capability =
    sponsorPrincipalId === null
      ? { serverExecutable: true, compatibleRunnerConnected: false }
      : await capabilityFor(
          db,
          repositoryId,
          sponsorPrincipalId,
          new Date().toISOString(),
          policy?.securityProfile ?? null,
        );
  const folded = foldCapability({ ready: baseReady, primaryReason: basePrimaryReason }, capability);

  // Enqueue, evaluate readiness, tick the scheduler and claim the offer, all
  // against the stored document. This was a Durable Object round trip, which
  // is the one resource with a daily cliff; it is now a row read and, only when
  // something actually changed, a row write.
  const { snapshot: held } = await onQueue(env, repositoryId, baseRef, ({ store, commands }) =>
    sponsorPrincipalId === null
      ? buildSnapshot(store)
      : admit(commands, store, {
          entryId,
          pullRequestNumber,
          sponsorPrincipalId,
          sponsorGithubUserId,
          headSha,
          ready: baseReady,
          schedulerEligible: folded.schedulerEligible,
          primaryReason: folded.primaryReason,
          // Time buckets, so a retried check re-evaluates rather than being
          // deduplicated against a decision taken minutes ago, while a burst of
          // parallel jobs for one head still collapses to one turn.
          readinessBucket: Math.floor(Date.now() / 60_000),
          tickBucket: Math.floor(Date.now() / 60_000),
          // Under `fresh` and `audited` the offer belongs to the developer's
          // machine, which claims it at `/claim`. A server that claimed here
          // would take the turn away from the runner it is waiting on and then
          // merge on the head's own proof, which is the `fast` merge wearing
          // another profile's name.
          serverMayClaim: !deviceOnly,
        }),
  );

  let operationId: string | null = null;
  let latest = held;
  // Only for the entry that holds the lane. Somebody else's turn is answered
  // from the snapshot below, and reading GitHub for a pull request that is
  // merely waiting would spend a call to say what the queue already knows.
  // The App is the only writer, so it walks the holder and starts the
  // merge-confirmation clock at the point where it can perform the write.
  if (appWillWrite && held.activeAttemptId !== null && held.activeEntryId === entryId) {
    const attemptId = held.activeAttemptId;
    const holder = held.entries.find((e) => e.entryId === entryId);

    // The base and the candidate, read here rather than taken from whoever is
    // asking.
    //
    // The caller used to send all four objects. A workflow read the pull
    // request, sent what it saw, and the queue signed against that reading
    // however old it had become on the way. On 2 August 2026 four pull
    // requests merged into this repository and no chain record could be
    // written for any of them: pull request 117's intent was signed sixteen
    // seconds after its base had already been superseded, the merge landed on
    // the tip the branch really had, and none of the seventy stored intents
    // pins any of the four trees that landed. `authorizationFor` compares the
    // exact tree and the exact parents, so a merge nothing pinned can only be
    // filed as an external transition, which claims far less than a merge.
    //
    // So the queue asks GitHub itself, inside the guard that signs. Nothing
    // below reads the caller's numbers.
    const current =
      deps.integratedCandidate === undefined
        ? null
        : await deps
            .integratedCandidate(env, repositoryId, baseRef, input.pullRequestNumber)
            .catch(() => null);
    if (current === null || current.status !== "pinned") {
      // Why there is no candidate, in the words of the state GitHub is
      // actually in. All eight used to arrive as `BASE_UNREADABLE`, so a pull
      // request that had developed a conflict was told GitHub was
      // unreachable, and the attempt held the lane until the execution
      // deadline reaped it. `BASE_UNREADABLE` now means only what it says:
      // the repository itself could not be read, which says nothing about
      // this pull request.
      const reason: CandidateStateReason | "BASE_UNREADABLE" =
        current === null ? "BASE_UNREADABLE" : current.reason;

      // A pull request that is closed or conflicting cannot merge from this
      // turn or any turn until somebody changes it, so the turn ends here and
      // the lane goes to whoever is behind it. Everything else is transient:
      // mergeability GitHub has not finished computing, a candidate it has
      // not rebuilt yet. Those keep the turn and are asked again.
      let after: QueueSnapshot | null = null;
      if (reason === "MERGE_CONFLICT") {
        ({ snapshot: after } = await onQueue(env, repositoryId, baseRef, ({ store, commands }) => {
          if (store.state().activeAttemptId !== attemptId) return;
          commands.terminateAttempt({
            idempotencyKey: `authorize:conflict:${attemptId}`,
            attemptId,
            outcome: "MERGE_CONFLICT",
          });
        }));
      } else if (reason === "PR_CLOSED") {
        ({ snapshot: after } = await onQueue(env, repositoryId, baseRef, ({ commands }) => {
          commands.cancel({
            idempotencyKey: `authorize:closed:${entryId}:${headSha}`,
            entryId,
            actorPrincipalId: "github",
            reason: "the pull request is closed",
          });
        }));
      }

      // The lane, driven on the way out. GitHub invalidates mergeability for
      // every open pull request the moment one lands, so the run dispatched a
      // second later reads null, is refused here, and is spent. Nothing re-drove
      // the lane, so the next attempt waited for the five-minute cron and the
      // branch merged once per five minutes.
      return {
        outcome: "refused",
        activationState: project.activationState,
        reason,
        detail: nextAction(reason),
        entryId,
        // Only where asking again is the answer. A turn that ended here waits
        // on a person, and telling the caller to come back in twenty seconds
        // would say the opposite.
        ...(after === null ? { retryAfterSeconds: 20 } : {}),
      };
    }
    if (current.headSha !== headSha) {
      // A push landed while this turn was being asked about. The candidate
      // GitHub is offering integrates a commit whose proof nothing here has
      // read, and the entry's own head follows on the next ask.
      return {
        outcome: "refused",
        activationState: project.activationState,
        reason: "HEAD_MOVED",
        detail: nextAction("HEAD_MOVED"),
        entryId,
      };
    }

    // The branch has moved off the base this attempt was integrated against.
    //
    // The reducer holds a pinned candidate immutable, so this turn can only
    // ever produce a merge onto a base that is gone. Signing anything for it
    // would pin a tree no branch will take, and walking it would mint an
    // operation for a write that fails. The attempt ends BASE_MOVED, which
    // defers: the place in line is kept and the next turn is taken against
    // the base that is there now.
    const alreadyPinned = held.activeCandidate;
    if (alreadyPinned !== null && alreadyPinned.baseSha !== current.baseSha) {
      const { snapshot: after } = await onQueue(env, repositoryId, baseRef, ({ store, commands }) => {
        if (store.state().activeAttemptId !== attemptId) return;
        commands.terminateAttempt({
          idempotencyKey: `authorize:base-moved:${attemptId}:${current.baseSha}`,
          attemptId,
          outcome: "BASE_MOVED",
        });
      });
      return {
        outcome: "refused",
        activationState: project.activationState,
        reason: "CANDIDATE_BASE_MOVED",
        detail: `${nextAction("CANDIDATE_BASE_MOVED")} ${baseRef} is ${current.baseSha}, and this candidate was integrated against ${alreadyPinned.baseSha}.`,
        entryId,
      };
    }
    const cand = {
      baseSha: current.baseSha,
      candidateSha: current.candidateSha,
      candidateTreeOid: current.candidateTreeOid,
    };

    // Nothing may be certified until the integrated candidate has actually been
    // run. Until this check existed the walk below used a constant in place of a
    // verifier result, so the queue recorded a verified transition for an
    // integration no suite had ever seen.
    //
    // What the developer's machine did, from storage. Under `fresh` and
    // `audited` a merge is refused here unless a receipt this queue accepted
    // is about this attempt and this tree, and the walk below cannot be
    // performed without the value this returns.
    const evidence = await localRunEvidenceFor(db, {
      securityProfile: policy?.securityProfile ?? null,
      attemptId,
      candidateTreeOid: cand.candidateTreeOid,
    });
    if (!evidence.ok) {
      return {
        outcome: "refused",
        activationState: project.activationState,
        reason: evidence.code,
        detail: evidence.detail,
        entryId,
      };
    }
    const localRun = evidence.evidence.localRun;

    // Under the fast profile the policy's own evidence is the proof on the head,
    // so there is nothing further to establish. Under every other profile the
    // queue is about to claim the integration itself was run, and that claim needs
    // a result. A profile that makes the stronger claim with no pinned verifier
    // cannot be satisfied by anything, so it refuses rather than quietly weakening.
    // No active policy means no stronger claim is being made, so the head proof
    // stands, as it did before candidate verification existed.
    //
    // `fresh` is the one profile whose integrated run happens somewhere else.
    // Its suites ran on the device, under an assignment this queue signed, and
    // dispatching those suites to GitHub Actions is a different security profile
    // says `fresh` does not have. `audited` asks for both, and still does.
    const needsIntegratedRun = policy !== null && requiresRemoteVerification(policy.securityProfile);
    // Null unless something actually ran. Under reuse nothing does, and the
    // constant that used to sit here was stored on the attempt as though a
    // verifier had spoken.
    let verifiedResultDigest: string | null = null;
    let candidatePolicyDigest = policy?.policyDigest ?? `sha256:${"0".repeat(64)}`;

    if (needsIntegratedRun && policy !== null) {
      if (policy.verifier === null || policy.requiredSuites.length === 0) {
        return {
          outcome: "refused",
          activationState: project.activationState,
          reason: "NO_PINNED_VERIFIER",
          detail:
            "this profile claims the integrated candidate was run, and no pinned verifier or required suite can establish that",
          entryId,
        };
      }
      const stored = await readCandidateVerdict(
        env.DB as unknown as D1Like,
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
            env.DB as unknown as D1Like,
            repositoryId,
            baseRef,
            cand.candidateTreeOid,
            new Date().toISOString(),
            CANDIDATE_DISPATCH_STALE_MS,
          );
          const dispatched = mine
            ? await deps.dispatchCandidateVerification(env, repositoryId, {
                baseRef,
                pullRequestNumber: input.pullRequestNumber,
                attemptId,
                baseSha: cand.baseSha,
                candidateSha: cand.candidateSha,
                candidateTreeOid: cand.candidateTreeOid,
                // Named here rather than typed into the verifier workflow. A
                // verdict that covers a different set of suites than the
                // policy requires is refused as CANDIDATE_SUITES_INCOMPLETE,
                // and the workflow has no way to know what the policy says.
                requiredSuites: policy.requiredSuites,
              })
            : ({ ok: true } as const);
          if (!dispatched.ok) {
            // Nothing will arrive, so waiting is the wrong answer. Say what
            // GitHub refused so it can be fixed rather than waited out.
            return {
              outcome: "refused",
              activationState: project.activationState,
              reason: "CANDIDATE_DISPATCH_FAILED",
              detail: `GitHub refused the verifier dispatch (${dispatched.status}): ${dispatched.detail}`,
              entryId,
            };
          }
          return {
            outcome: "verification-requested",
            enforcing: project.activationState !== "observe",
            activationState: project.activationState,
            entryId,
          };
        }
        return {
          outcome: "refused",
          activationState: project.activationState,
          reason: decision.code,
          detail: decision.detail,
          entryId,
        };
      }
      verifiedResultDigest = decision.resultDigest;
      candidatePolicyDigest = policy.policyDigest;
    }

    // A local run leaves the entry past `Active` before anything asks for the
    // merge: the device claims the offer, runs, and its receipt moves the
    // entry to `Verifying`. Only the walk itself moves a reuse entry that far,
    // so the wider set is opened for the local-run path alone.
    const walkable =
      holder !== undefined &&
      (holder.state === "Active" ||
        (localRun !== null && (holder.state === "Verifying" || holder.state === "MergeGuard")));
    if (walkable && holder !== undefined) {
      // Whether the repository is still the one the policy assumes.
      //
      // The queue's guarantee rests on facts about the repository that it does
      // not own: the branch ruleset requiring the checks the queue publishes,
      // the App holding the permissions the merge needs, and the sponsor
      // holding write access. Any of the three can change after the turn was
      // offered, and each has a reason code and a sentence that nothing was
      // reaching.
      //
      // Here rather than on every ask, because each answer costs a GitHub
      // read and a pull request waiting its turn asks once a minute. This is
      // the same trade the required-check read below makes, and the same
      // treatment of an unreadable answer: unknown is not a refusal.
      //
      // Read first, because a drifted repository is more actionable than a
      // missing check on the head, and because refusing here saves the reads
      // below.
      const health =
        deps.platformHealth === undefined
          ? null
          : await deps
              .platformHealth(env, repositoryId, baseRef, sponsorGithubUserId)
              .catch(() => null);
      if (health !== null) {
        // The pull request's own facts with the three refreshed, rather than a
        // fresh permissive object. Spreading a constant that objected to
        // nothing meant this gate could only ever produce the three reasons it
        // set, and the other twenty read as satisfied here whatever the
        // derivation above had just decided about them.
        const stillHolds = deriveReadiness({
          ...facts,
          ownerAuthorized: health.sponsorAuthorized,
          appPermissionsHealthy: health.appPermissionsHealthy,
          rulesetEnforced: health.rulesetEnforced,
        });
        if (!stillHolds.ready && stillHolds.primaryReason !== null) {
          return {
            outcome: "refused",
            activationState: project.activationState,
            reason: stillHolds.primaryReason,
            // The sentence the check, the terminal and the dashboard already
            // agree on. A fourth copy written here is how they came apart
            // before.
            detail: nextAction(stillHolds.primaryReason),
            entryId,
          };
        }
      }

      // What the branch requires, before the queue commits to a merge.
      //
      // The merge is a PUT the caller makes once this returns an operation, and
      // GitHub refuses it outright when a required check is not on the head.
      // The queue used to find that out from the 405: by then it had signed an
      // intent, minted an operation and started the confirmation clock, and the
      // attempt held the lane until a person cleared it. Everything behind it
      // waited. That happened to four pull requests on one day.
      //
      // Both facts are readable here. Refusing now costs a turn; discovering it
      // from GitHub's answer cost the queue.
      //
      // Only the certain cases, and only when GitHub answered. A check still
      // running may yet pass, and rules that could not be read say nothing
      // about this head.
      //
      // The readiness derivation above already read this for an entry that
      // was otherwise ready. Reusing its answer is one GitHub read rather
      // than two, and it removes the case where the two gates read the same
      // head a second apart and disagree.
      const requiredChecks =
        branchChecks ??
        (deps.requiredCheckState === undefined
          ? null
          : await deps.requiredCheckState(env, repositoryId, baseRef, headSha).catch(() => null));
      const unsatisfied = requiredChecks === null ? [] : unsatisfiedRequiredChecks(requiredChecks);
      if (unsatisfied.length > 0) {
        const named = unsatisfied
          .map((check) =>
            check.state === "absent"
              ? `"${check.context}", which nothing has published on this commit`
              : `"${check.context}", which did not pass`,
          )
          .join("; ");
        return {
          outcome: "refused",
          activationState: project.activationState,
          reason: "REQUIRED_CHECK_MISSING",
          detail: `this branch requires ${named}. GitHub would refuse the merge, so the queue is not asking for it.`,
          entryId,
        };
      }

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
      // Reused from the readiness read above when that happened, so one head
      // is read once and the two gates cannot see different proofs on it.
      const head = headCommit ?? (await deps.commitFacts(env, repositoryId, headSha));
      const workReceiptDigest =
        head?.message === undefined ? null : await workReceiptDigestFrom(head.message);
      if (workReceiptDigest === null) {
        return {
          outcome: "refused",
          activationState: project.activationState,
          reason: "WORK_RECEIPT_UNREADABLE",
          detail:
            "the head commit carries no readable thwip proof, so there is nothing for the merge record to cite",
          entryId,
        };
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
      //
      // A device ran this candidate under an assignment this queue signed, so
      // the intent says that rather than describing a reuse. The two are
      // different claims and the schemas refuse to be each other.
      const evidenceForIntent =
        localRun === null || policy === null
          ? await reuseEvidenceFor(
              workReceiptDigest,
              policy,
              await deps.proofCheckRunId(env, repositoryId, headSha),
              verifiedResultDigest,
              // What the proof itself bound, so the record's equivalence
              // digests are compared against the work rather than copied
              // over it.
              head?.message === undefined ? null : proofBindingFrom(head.message),
            )
          : verifiedEvidenceFor({
              workReceiptDigest,
              organizationId: policy.organizationId,
              policyDigest: policy.policyDigest as Sha256,
              pipelineDigest: policy.pipelineDigest as Sha256 | null,
              requiredSuitesDigest: await requiredSuitesDigest(policy.requiredSuites),
              assignmentDigest: localRun.assignmentDigest as Sha256,
              integrationEvidenceDigest: localRun.receiptDigest as Sha256,
              deviceKeyId: localRun.deviceKeyId,
              // `audited` runs the suites again in Actions. That execution's
              // run ids are not carried this far, so the record names the
              // device's run rather than a rerun it cannot cite.
              rerun: null,
            });
      if ("missing" in evidenceForIntent) {
        // A proof that does not bind the policy in force has its own reason
        // code and its own sentence, because the developer's next move is to
        // sign the head again rather than to chase absent evidence.
        const refusal = evidenceForIntent.reason;
        return {
          outcome: "refused",
          activationState: project.activationState,
          reason: refusal ?? "MERGE_EVIDENCE_INCOMPLETE",
          detail:
            refusal === undefined
              ? `nothing may be signed for this merge: ${evidenceForIntent.missing}`
              : `${nextAction(refusal)} ${evidenceForIntent.missing}.`,
          entryId,
        };
      }
      const evidenceOrganizationId = evidenceForIntent.organizationId;

      const intentSubject = {
        operationId: mergeOperationId(attemptId),
        attemptId,
        git: {
          objectFormat: "sha1" as const,
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
        pullRequestNumber: input.pullRequestNumber,
        mergeMethod: "merge" as const,
        createdAt: new Date().toISOString(),
        signer: { sign: (bytes: Uint8Array, typ: string) => deps.signRecordBytes(env, bytes, typ) },
      };
      const signedIntent =
        "assignmentDigest" in evidenceForIntent
          ? await signVerifiedIntent({ ...intentSubject, evidence: evidenceForIntent })
          : await signReusedIntent({ ...intentSubject, evidence: evidenceForIntent });
      if ("error" in signedIntent) {
        return {
          outcome: "refused",
          activationState: project.activationState,
          reason: "MERGE_INTENT_INVALID",
          detail: `the queue refused to sign its own merge intent: ${signedIntent.error}`,
          entryId,
        };
      }
      await storeAttestation(env.DB as unknown as D1Like, {
        digest: signedIntent.digest,
        kind: "merge-intent",
        repositoryId,
        baseRef,
        transitionSequence: null,
        attemptId,
        bytes: signedIntent.bytes,
        jws: signedIntent.jws,
        organizationId: evidenceOrganizationId,
        mirror: (input) =>
          storeEvidence(env, {
            organizationId: input.organizationId,
            repositoryId: input.repositoryId,
            kind: input.kind,
            digest: input.digest as `sha256:${string}`,
            bytes: input.bytes,
          }).then(() => undefined),
      });

      const { result: walked } = await onQueue(env, repositoryId, baseRef, ({ store, commands }) => {
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
          runner: localRun !== null ? "local-run" : needsIntegratedRun ? "verified-candidate" : "reuse",
          evidence: evidence.evidence,
          receiptDigest: workReceiptDigest,
          // What the merge rests on having been run. A device's accepted
          // receipt is that account under `fresh`; under `audited` the second
          // execution in Actions is, and it is the stronger of the two.
          verifierResultDigest: verifiedResultDigest ?? localRun?.receiptDigest ?? null,
          intentDigest: signedIntent.digest,
          operationId: mergeOperationId(attemptId),
        });
      });
      operationId = walked.operationId;
      latest = walked.snapshot;
      // Say why the evidence was refused, rather than falling through to
      // "waiting for turn" and leaving an operator to guess. Only the
      // evidence refusals are answered here: a walk stopped by a pause or a
      // moved base already has a better answer below, from the snapshot.
      const refusal = walked.refusal;
      if (
        walked.operationId === null &&
        refusal !== undefined &&
        (refusal.startsWith("INTEGRATION_") || refusal === "CANDIDATE_CHANGED")
      ) {
        return {
          outcome: "refused",
          activationState: project.activationState,
          reason: refusal,
          detail: "the queue document and the evidence for this merge do not agree",
          entryId,
        };
      }
    }
  }

  const snapshot = latest;
  const entry = snapshot.entries.find((e) => e.entryId === entryId);

  // An attempt already walked to merge-ready by an earlier caller still has an
  // operation, and the caller that will perform the write needs its id. Without
  // this, the second asker is told it holds the turn and given nothing to act on,
  // so nothing ever merges.
  if (operationId === null && snapshot.activeAttemptId !== null && entry?.state === "Merging") {
    operationId = mergeOperationId(snapshot.activeAttemptId);
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

  return {
    outcome: "settled",
    authorized,
    enforcing,
    activationState: project.activationState,
    reason: halted
      ? snapshot.rebaselineRequired
        ? "REBASELINE_REQUIRED"
        : "QUEUE_PAUSED"
      : holdsLane
        ? "HOLDS_TURN"
        : // No entry means no sponsor, and `unplaceableReason` says whether
          // that is a bot with nobody behind it, which a person can clear.
          (entry?.primaryReason ?? unplaceableReason ?? "WAITING_FOR_TURN"),
    entryId,
    operationId,
    queuePosition: snapshot.entries.filter((e) => e.state === "Ready").length,
  };
}

/**
 * Enrol and evaluate a pull request for the check-facing API.
 *
 * This never prepares or writes a merge. The installed App owns that side
 * effect through `authorizeAppWrite`, which is called only by internal wake
 * paths after the check has established queue state.
 */
export function authorizeTurn<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: AuthorizeTurnDeps<TEnv>,
  onQueue: OnQueue<TEnv>,
  input: TurnRequest,
): Promise<TurnAuthorization> {
  return walkTurn(env, deps, onQueue, input, false);
}

/** Walk the holder to a signed intent so the installed App can write it. */
export function authorizeAppWrite<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: AuthorizeTurnDeps<TEnv>,
  onQueue: OnQueue<TEnv>,
  input: TurnRequest,
): Promise<TurnAuthorization> {
  return walkTurn(env, deps, onQueue, input, true);
}
