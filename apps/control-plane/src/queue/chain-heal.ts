import { recordDigest, type Sha256 } from "@thwip/queue-protocol";
import { authorizationFor, storeAttestation } from "./attestation.js";
import { buildExternalTransitionRecord, signTransitionRecord } from "./evidence.js";
import type { D1Like } from "./projection.js";
import { readQueue, recordMergeFromIntent, type RecordFromIntentDeps } from "./record-from-intent.js";
import type { QueueRouteEnv } from "./routes.js";
import type { SelfCheckFinding } from "./chain-self-check.js";

/**
 * Turning a chain finding into the call that answers it.
 *
 * The verifier has reported `BASE_DISCONTINUITY` since the day the first
 * unrecorded merge was understood, and reading one used to be the start of an
 * afternoon. Somebody opened D1, listed the merge intents for the repository,
 * asked GitHub for each commit in the gap, compared trees and parent vectors by
 * eye, worked out which attempt authorized which commit, and called `/repair`
 * once per merge. Every step of that is mechanical, and the queue holds both
 * halves of every comparison already.
 *
 * So it does the search itself. Given the two shas the finding names, it walks
 * first parents from the far end back to the near one, which is exactly the
 * commits that moved the branch, and asks `authorizationFor` about each. Every
 * answer that search can give is kept apart from the others:
 *
 * - One intent authorizes the commit, and it is one a record can be rebuilt
 *   from. The remedy is the repair that already exists, with the attempt named.
 * - No intent authorizes it. The queue never pinned that tree on those parents,
 *   so no merge record can be written. What can be written is that the branch
 *   moved and the queue did not certify the move, which is weaker on purpose.
 * - Two attempts authorize it. Nothing is written and both are named. Picking
 *   would be a guess wearing a signature.
 * - One attempt's intents authorize it and disagree. Both digests are named. A
 *   movement record here would deny a movement the queue's own signatures pin.
 * - The intent is a verified or an override merge, whose record binds evidence
 *   the intent never carried. Nothing can rebuild it, so nothing offers to.
 *
 * The healing does not widen what a record may claim. It removes the forensics
 * in front of a call that was already safe, and where the safe call cannot be
 * made it says the true thing instead of the strong one.
 */

/** What the queue would do about one commit in a gap. */
export type HealStep =
  | {
      readonly action: "record-merge";
      readonly commitSha: string;
      readonly attemptId: string;
      readonly pullRequestNumber: number;
      readonly intentDigest: string;
      readonly sentence: string;
    }
  | {
      readonly action: "record-movement";
      readonly commitSha: string;
      readonly sentence: string;
    }
  | {
      readonly action: "ask-a-person";
      readonly commitSha: string;
      readonly attemptIds: readonly string[];
      /** Which of the ways a commit stops thwip short this is. */
      readonly reason: AskReason;
      readonly sentence: string;
    };

/**
 * Why a commit needs a person.
 *
 * Three different questions, and the summary an administrator reads has to ask
 * the right one. Two attempts authorize the commit and somebody must say which
 * merged it. One attempt signed two intents that disagree and somebody must say
 * which the merge ran under. Or the intent is one whose record cites evidence
 * the intent does not carry, so nothing can rebuild it.
 */
type AskReason = "AMBIGUOUS_ATTEMPT" | "INTENTS_DISAGREE" | "NOT_REBUILDABLE";

export interface HealPlan {
  readonly code: SelfCheckFinding["code"];
  readonly sequence: number | null;
  readonly digest: string;
  readonly detail: string;
  /** What the button does, as a sentence an administrator can act on. */
  readonly summary: string;
  readonly steps: readonly HealStep[];
  /** True when every step is one the queue can carry out on its own. */
  readonly healable: boolean;
}

/**
 * How far back a heal will walk to reach the near end of a gap.
 *
 * The walk costs one commit read per step and every read is a Worker
 * subrequest, so an unbounded walk on a chain that fell a long way behind
 * would run the invocation out of budget and fail the whole request. Twenty is
 * far more than any gap this has seen; the largest was two. A gap longer than
 * this is reported as needing a person, which is true.
 */
const HEAL_WALK_LIMIT = 20;

/** The gap the finding names, or nothing, because only some kinds have one. */
function gapOf(finding: SelfCheckFinding): { from: string; to: string } | null {
  if (finding.code !== "BASE_DISCONTINUITY") return null;
  const gap = finding.gap;
  return gap === undefined ? null : { from: gap.from, to: gap.to };
}

/** A finding nothing can be built for, with the reason said plainly. */
function unhealable(finding: SelfCheckFinding, summary: string): HealPlan {
  return {
    code: finding.code,
    sequence: finding.sequence,
    digest: finding.digest,
    detail: finding.detail,
    summary,
    steps: [],
    healable: false,
  };
}

export interface HealDeps<TEnv extends QueueRouteEnv> {
  commitFacts: RecordFromIntentDeps<TEnv>["commitFacts"];
}

/**
 * The commits that moved the branch across a gap, oldest first.
 *
 * First parents only. On a merge queue the first parent is the branch and the
 * second is what was merged into it, so the first-parent path from the far end
 * of a gap back to the near end is precisely the movements a record covers. A
 * walk that followed both parents would drag in every commit of every pull
 * request and claim the branch had visited them.
 */
async function commitsInGap<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: HealDeps<TEnv>,
  repositoryId: string,
  gap: { from: string; to: string },
): Promise<
  | { readonly walked: ReadonlyArray<{ sha: string; treeOid: string; parentShas: readonly string[] }> }
  | { readonly stopped: string }
> {
  const walked: Array<{ sha: string; treeOid: string; parentShas: readonly string[] }> = [];
  let cursor = gap.to;
  for (let step = 0; step < HEAL_WALK_LIMIT && cursor !== gap.from; step += 1) {
    const facts = await deps.commitFacts(env, repositoryId, cursor);
    if (facts === null) return { stopped: `${cursor} could not be read from GitHub` };
    walked.push({ sha: cursor, treeOid: facts.treeOid, parentShas: facts.parentShas });
    const parent = facts.parentShas[0];
    if (parent === undefined) {
      return { stopped: `the history from ${gap.to} reaches a root commit without passing ${gap.from}` };
    }
    cursor = parent;
  }
  if (cursor !== gap.from) {
    return { stopped: `${gap.from} is more than ${HEAL_WALK_LIMIT} commits behind ${gap.to}` };
  }
  return { walked: walked.reverse() };
}

/** What is left for a person, said as the question they have to answer. */
function stuckSentence(reason: AskReason): string {
  if (reason === "AMBIGUOUS_ATTEMPT") {
    return "Two attempts authorize one of these commits, so thwip will not choose between them. Somebody has to say which attempt merged it.";
  }
  if (reason === "INTENTS_DISAGREE") {
    return "One attempt signed two merge intents that disagree about what they authorized, so thwip cannot tell which one a record should cite. Somebody has to read both and say which the merge ran under.";
  }
  return "A record for one of these merges repeats evidence its intent never carried, so thwip cannot rebuild it from what survives. Somebody has to record it from the verifier result or the override that authorized it.";
}

/** One English sentence for a plan, so the product does not have to compose one. */
function summarize(steps: readonly HealStep[]): string {
  const stuck = steps.filter((s): s is Extract<HealStep, { action: "ask-a-person" }> => s.action === "ask-a-person");
  const merges = steps.filter((s) => s.action === "record-merge").length;
  const moves = steps.filter((s) => s.action === "record-movement").length;
  if (stuck.length > 0) {
    const reasons = [...new Set(stuck.map((s) => s.reason))];
    return reasons.map(stuckSentence).join(" ");
  }
  const parts: string[] = [];
  if (merges > 0) {
    parts.push(
      `${merges} merge${merges === 1 ? "" : "s"} thwip found the intent for, ` +
        `recorded ${merges === 1 ? "as a merge citing that intent" : "as merges citing those intents"}`,
    );
  }
  if (moves > 0) {
    parts.push(
      `${moves} movement${moves === 1 ? "" : "s"} no intent authorizes, recorded as the base moving ` +
        `without the queue certifying it, which is weaker than a merge record and is what the evidence supports`,
    );
  }
  return `Recording this writes ${parts.join(", and ")}, at the end of the chain.`;
}

/**
 * What the queue would do about one finding, without doing any of it.
 *
 * Read-only. Nothing here signs, stores or moves anything, so a project page
 * can show the remedy beside the finding and an administrator can read what the
 * button does before pressing it.
 */
export async function planHeal<TEnv extends QueueRouteEnv>(
  env: TEnv,
  db: D1Like,
  deps: HealDeps<TEnv>,
  input: { readonly repositoryId: string; readonly baseRef: string; readonly finding: SelfCheckFinding },
): Promise<HealPlan> {
  const { finding, repositoryId, baseRef } = input;
  const gap = gapOf(finding);
  if (gap === null) {
    return unhealable(
      finding,
      "thwip has no remedy built from evidence it holds for this finding. Somebody has to look at it.",
    );
  }

  const walk = await commitsInGap(env, deps, repositoryId, gap);
  if ("stopped" in walk) return unhealable(finding, `thwip could not read the gap: ${walk.stopped}.`);

  const steps: HealStep[] = [];
  for (const commit of walk.walked) {
    const authorization = await authorizationFor(db, {
      repositoryId,
      baseRef,
      treeOid: commit.treeOid,
      parentShas: commit.parentShas,
    });
    if ("refused" in authorization) {
      if (authorization.code === "AMBIGUOUS_ATTEMPT") {
        steps.push({
          action: "ask-a-person",
          commitSha: commit.sha,
          attemptIds: authorization.attemptIds,
          reason: "AMBIGUOUS_ATTEMPT",
          sentence: `${commit.sha} is authorized by ${authorization.attemptIds.join(" and ")}`,
        });
        continue;
      }
      // Signed intents pin this commit. They reached here only because one or
      // more of them pins exactly this tree on exactly these parents, and they
      // differ over something a record repeats. A movement record would say
      // the queue never certified a movement its own signatures pin, so both
      // documents go to a person by digest instead.
      if (authorization.code === "INTENTS_DISAGREE") {
        steps.push({
          action: "ask-a-person",
          commitSha: commit.sha,
          attemptIds: authorization.attemptIds,
          reason: "INTENTS_DISAGREE",
          sentence:
            `${commit.sha} is pinned by merge intents that disagree about what they authorized: ` +
            `${authorization.intentDigests.join(" and ")}. A record has to cite one of them.`,
        });
        continue;
      }
      if (authorization.code === "NO_INTENT") {
        steps.push({
          action: "record-movement",
          commitSha: commit.sha,
          // Said with the comparison in it, because the comparison is the whole
          // answer to "why not a merge record". A reader who can see the tree
          // and the parents the queue never pinned does not have to take this on
          // trust or go looking in D1 for it.
          sentence:
            `no signed intent pins tree ${commit.treeOid} on ${commit.parentShas.join(" and ")}, ` +
            `so thwip can only record that ${baseRef} moved to ${commit.sha} without the queue certifying it`,
        });
        continue;
      }
      // `authorizationFor` refuses with exactly three codes, each matched by
      // name above so it gets its own sentence. A movement record claims
      // that no intent pins the commit, a claim only `NO_INTENT` supports.
      // The line below turns a fourth code, whatever it says, into a build
      // failure the day `AuthorizationRefusal` grows one, instead of a
      // silent fall-through that would plan a movement record for a reason
      // this function has never read.
      const unreachable: never = authorization.code;
      throw new Error(`chain-heal received an authorization refusal it does not handle: ${String(unreachable)}`);
    }
    // The write path rebuilds a record from the intent, and only two kinds
    // survive that. A verified merge's record binds the Actions run that
    // verified the candidate, which the intent never carried, and an override's
    // binds an authorization nothing may reissue. Offering a button here would
    // put a control on the page whose only answer is a refusal, and across a
    // gap of several commits it would refuse after the earlier records had
    // already been written.
    const kind = authorization.intent.kind;
    if (kind !== "reused" && kind !== "candidate-verified") {
      steps.push({
        action: "ask-a-person",
        commitSha: commit.sha,
        attemptIds: [authorization.intent.attemptId],
        reason: "NOT_REBUILDABLE",
        sentence:
          `pull request ${authorization.intent.pullRequestNumber} merged as ${commit.sha} under ` +
          `${authorization.intent.attemptId}, and a ${kind} merge's record repeats evidence its intent ` +
          `never carried, so thwip cannot rebuild it`,
      });
      continue;
    }
    steps.push({
      action: "record-merge",
      commitSha: commit.sha,
      attemptId: authorization.intent.attemptId,
      pullRequestNumber: authorization.intent.pullRequestNumber,
      intentDigest: authorization.intentDigest,
      sentence: `pull request ${authorization.intent.pullRequestNumber} merged as ${commit.sha}, authorized by ${authorization.intent.attemptId}`,
    });
  }

  return {
    code: finding.code,
    sequence: finding.sequence,
    digest: finding.digest,
    detail: finding.detail,
    summary: summarize(steps),
    steps,
    healable: steps.length > 0 && steps.every((s) => s.action !== "ask-a-person"),
  };
}

export type HealOutcome =
  | { readonly status: "healed"; readonly wrote: ReadonlyArray<{ commitSha: string; kind: string; sequence: number }> }
  | { readonly status: "refused"; readonly code: HealRefusal; readonly detail: string };

export type HealRefusal =
  | "NOT_HEALABLE"
  | "MERGE_NOT_ON_BASE"
  | "BASE_UNREADABLE"
  | "SIGNING_REFUSED"
  | "CHAIN_MOVED"
  | "INTENT_PINS_COMMIT";

export interface ApplyHealDeps<TEnv extends QueueRouteEnv> extends RecordFromIntentDeps<TEnv> {}

/**
 * Carry out a plan, appending at the head of the chain.
 *
 * The plan is recomputed by the caller from a fresh verification, never handed
 * in, so an administrator cannot describe a gap that is not there. Steps run
 * oldest first and each one appends: a chain is hash-linked and a record's own
 * position is inside the bytes that were signed, so putting these merges back
 * where they happened chronologically would mean re-signing everything after
 * them, which replaces the chain rather than repairing it.
 *
 * The first step that refuses stops the run. Records already written stay, and
 * they are true whatever went wrong afterwards.
 */
export async function applyHeal<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: ApplyHealDeps<TEnv>,
  input: {
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly plan: HealPlan;
    readonly actorPrincipalId: string;
    readonly reason: string;
  },
): Promise<HealOutcome> {
  const { plan, repositoryId, baseRef } = input;
  if (!plan.healable) {
    const stuck = plan.steps.find((s) => s.action === "ask-a-person");
    return {
      status: "refused",
      code: "NOT_HEALABLE",
      detail: stuck === undefined ? plan.summary : stuck.sentence,
    };
  }

  const wrote: Array<{ commitSha: string; kind: string; sequence: number }> = [];
  for (const step of plan.steps) {
    if (step.action === "record-merge") {
      const recorded = await recordMergeFromIntent(env, deps, {
        repositoryId,
        baseRef,
        mergeSha: step.commitSha,
        witnessPrincipalId: input.actorPrincipalId,
        attemptId: step.attemptId,
      });
      if (recorded.status === "refused") {
        return { status: "refused", code: refusalOf(recorded.code), detail: recorded.detail };
      }
      if (recorded.status === "recorded") {
        wrote.push({ commitSha: step.commitSha, kind: "merge", sequence: recorded.sequence });
      }
      continue;
    }
    if (step.action === "ask-a-person") continue;

    const movement = await recordMovement(env, deps, {
      repositoryId,
      baseRef,
      commitSha: step.commitSha,
      actorPrincipalId: input.actorPrincipalId,
      reason: input.reason,
    });
    if ("refused" in movement) return { status: "refused", code: movement.code, detail: movement.refused };
    wrote.push({ commitSha: step.commitSha, kind: "external-transition", sequence: movement.sequence });
  }

  return { status: "healed", wrote };
}

/** The heal's names for what the repair path refuses with. */
function refusalOf(code: string): HealRefusal {
  if (code === "MERGE_NOT_ON_BASE") return "MERGE_NOT_ON_BASE";
  if (code === "BASE_UNREADABLE" || code === "COMMIT_UNREADABLE") return "BASE_UNREADABLE";
  if (code === "CHAIN_MOVED") return "CHAIN_MOVED";
  return "NOT_HEALABLE";
}

/**
 * The movement record this commit already has, and where it sits.
 *
 * Both callers report a sequence back to an operator who will go looking for
 * that link, so the answer has to be the position in the chain rather than the
 * position this run was aiming at.
 */
async function movementAlreadyInChain(
  db: D1Like,
  movementKey: string,
): Promise<{ sequence: number; digest: string } | null> {
  const row = await db
    .prepare(
      `SELECT digest, transition_sequence AS sequence FROM queue_attestations
        WHERE attempt_id = ? AND transition_sequence IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .bind(movementKey)
    .first<{ digest: string; sequence: number }>();
  return row === null ? null : { sequence: row.sequence, digest: row.digest };
}

/**
 * Write the record that says the branch moved and the queue did not cause it.
 *
 * Both gates the repair path uses are here too, and for the same reasons. The
 * commit's tree and parents come from GitHub rather than the caller, and the
 * branch is asked whether it contains the commit, because a commit that exists
 * is not a commit that landed and the test merge GitHub computes for an open
 * pull request exists.
 */
async function recordMovement<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: ApplyHealDeps<TEnv>,
  input: {
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly commitSha: string;
    readonly actorPrincipalId: string;
    readonly reason: string;
  },
): Promise<{ sequence: number; digest: string } | { refused: string; code: HealRefusal }> {
  const { repositoryId, baseRef, commitSha } = input;
  const db = env.DB as unknown as D1Like;

  const facts = await deps.commitFacts(env, repositoryId, commitSha);
  if (facts === null) return { refused: `could not read ${commitSha}`, code: "BASE_UNREADABLE" };

  // The record about to be signed says no signed intent pins this commit. The
  // planner decided that, and a plan travels here as data, so the claim is
  // checked again against the rows it is a claim about. A movement record for a
  // commit the queue did pin would be a permanent signed denial of the queue's
  // own signature, and it is the one thing this path must never write.
  const pinned = await authorizationFor(db, {
    repositoryId,
    baseRef,
    treeOid: facts.treeOid,
    parentShas: facts.parentShas,
  });
  if (!("refused" in pinned) || pinned.code !== "NO_INTENT") {
    const digests = "refused" in pinned ? pinned.intentDigests : [pinned.intentDigest];
    return {
      refused:
        `${commitSha} is pinned by ${digests.length === 1 ? "a signed merge intent" : "signed merge intents"} ` +
        `(${digests.join(", ")}), so thwip will not record that the queue did not certify it`,
      code: "INTENT_PINS_COMMIT",
    };
  }

  const reachable = await deps.baseContainsSha(env, repositoryId, baseRef, commitSha);
  if (reachable !== true) {
    return {
      refused:
        reachable === false
          ? `${baseRef} does not contain ${commitSha}`
          : `${baseRef} could not be asked whether it contains ${commitSha}`,
      code: "MERGE_NOT_ON_BASE",
    };
  }

  const parent = facts.parentShas[0];
  if (parent === undefined) return { refused: `${commitSha} has no parent`, code: "BASE_UNREADABLE" };
  const before = await deps.commitFacts(env, repositoryId, parent);
  if (before === null) return { refused: `could not read ${parent}`, code: "BASE_UNREADABLE" };

  // Synthetic, and unique per commit, so the partial unique index on
  // `attempt_id` refuses a second record for the same movement. No queue
  // attempt authorized this, which is the whole finding, so there is no real
  // attempt id to put here and inventing one that looked real would be a lie
  // about where the record came from.
  const movementKey = `movement:${commitSha}`;
  const already = await movementAlreadyInChain(db, movementKey);
  if (already !== null) return already;

  const { snapshot } = await readQueue(env, repositoryId, baseRef);
  const head = snapshot.transitions.at(-1);
  const transitionSequence = (head?.transitionSequence ?? 0) + 1;
  const priorDigest = (head?.digest ?? null) as Sha256 | null;

  const document = await buildExternalTransitionRecord({
    repositoryId,
    baseRef,
    queueEpoch: snapshot.queueEpoch,
    transitionSequence,
    previousTransitionDigest: priorDigest,
    before: { baseSha: parent, treeOid: before.treeOid },
    moved: { sha: commitSha, treeOid: facts.treeOid, parentShas: facts.parentShas },
    // The branch moved and the queue holds nothing that says how. Naming a
    // stronger code, `unexpected_push` or `ruleset_bypass`, would assert a
    // mechanism nobody observed.
    observationReasonCode: "unknown_provider_movement",
    operatorReasonDigest: await recordDigest({
      actorPrincipalId: input.actorPrincipalId,
      reason: input.reason,
      healedCommit: commitSha,
    }),
    observedAt: new Date().toISOString(),
  });

  const signed = await signTransitionRecord(document, {
    sign: (bytes, typ) => deps.signRecordBytes(env, bytes, typ),
  });
  if ("error" in signed) {
    return { refused: `the queue refused to sign its own record: ${signed.error}`, code: "SIGNING_REFUSED" };
  }

  const policy = await deps.activePolicy(env, repositoryId);
  const stored = await storeAttestation(db, {
    digest: signed.digest,
    kind: "external-transition",
    repositoryId,
    baseRef,
    transitionSequence,
    attemptId: movementKey,
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
            deps
              .storeEvidence(env, {
                organizationId: mirrored.organizationId,
                repositoryId: mirrored.repositoryId,
                kind: mirrored.kind,
                digest: mirrored.digest as `sha256:${string}`,
                bytes: mirrored.bytes,
              })
              .then(() => undefined),
        }),
  });
  if (!stored.stored) {
    // Another writer got there first. The position this run computed is the one
    // it lost the race for, so reporting it would name a link the caller cannot
    // find. What the caller wants is where the record that won actually sits.
    const winner = await movementAlreadyInChain(db, movementKey);
    return winner ?? { sequence: transitionSequence, digest: stored.digest };
  }

  const { result } = await deps.onQueue(env, repositoryId, baseRef, ({ commands, store }) => {
    const tail = store.state().transitions.at(-1);
    if ((tail?.transitionSequence ?? 0) + 1 !== transitionSequence || (tail?.digest ?? null) !== priorDigest) {
      return { moved: true as const };
    }
    commands.recordTransition({
      idempotencyKey: `heal:${commitSha}`,
      kind: "external",
      transitionSequence,
      priorDigest,
      digest: signed.digest,
      baseSha: commitSha,
      // No attempt merged this. The reducer would refuse an attempt whose
      // phase is not MERGED, and there is no attempt to name in the first
      // place: that absence is the finding.
      attemptId: null,
      witnessPrincipalIds: [input.actorPrincipalId],
    });
    return { moved: false as const };
  });

  if (result.moved) {
    // The chain grew while this was being signed. The bytes stay, because the
    // queue really did sign them and destroying signed evidence to tidy up is
    // a worse habit than keeping a row nothing points at. What goes is the
    // claim to a position.
    await db
      .prepare("UPDATE queue_attestations SET transition_sequence = NULL WHERE digest = ?")
      .bind(signed.digest)
      .run();
    return { refused: "the chain moved while this record was being signed; try again", code: "CHAIN_MOVED" };
  }

  return { sequence: transitionSequence, digest: signed.digest };
}
