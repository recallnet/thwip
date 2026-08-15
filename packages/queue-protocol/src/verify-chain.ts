import { envelopeDigest } from "./canonical.js";
import { parseTransitionRecord, type TransitionRecordV1 } from "./transition-record.js";

/**
 * Walking a branch's chain and saying whether it holds.
 *
 * The chain was a claim until this existed. Records were built, signed and
 * stored, and nothing ever checked that the links joined up, that a digest named
 * its own bytes, or that a signature was real. Three merges landed with no record
 * at all and it went unnoticed until somebody looked by hand.
 *
 * The digest and sequence checks did not see any of the three. A record is
 * numbered when it is written, so a merge nobody wrote down leaves the numbering
 * intact and the digests joined up. What it does disturb is the base: some
 * record begins at a sha no record ever reached, and every record already
 * carries both halves of the move it made.
 *
 * Which record that is has nothing to do with where it sits in the log. Records
 * written to repair a missed merge land at the head, because the chain is
 * append-only, while the merge they describe happened in the middle. So the
 * base check runs over the set of moves and not their order: each record is an
 * edge, and the chain holds when the edges form one path. See `walk`.
 *
 * Pure. Signature verification is injected so the same walk runs in the Worker,
 * in the CLI, and in a test, and so this file never needs a key or a network.
 */

export interface ChainLink {
  readonly digest: string;
  /** The exact bytes that were signed. Empty when there is no record to read. */
  readonly bytes: Uint8Array;
  readonly jws: string;
  /**
   * Where the store says this link sits. Supplied because a link whose bytes are
   * missing cannot say so itself, and "written before records existed" and "a
   * record that belongs here is gone" are different facts that must not collapse
   * into one.
   */
  readonly sequence?: number;
}

export interface ChainFinding {
  readonly code:
    | "DIGEST_MISMATCH"
    | "BROKEN_LINK"
    | "SEQUENCE_GAP"
    | "BASE_DISCONTINUITY"
    | "FORKED_BASE"
    | "CHAIN_BEHIND_HEAD"
    | "BAD_SIGNATURE"
    | "UNPARSEABLE"
    | "PRE_ATTESTATION"
    | "MISSING_RECORD"
    | "MISSING_PREFIX"
    | "CORRECTION_UNANCHORED"
    | "CORRECTION_OVERREACHES"
    | "WRONG_SUBJECT"
    | "GENESIS_MISPLACED";
  readonly sequence: number | null;
  readonly digest: string;
  readonly detail: string;
  /**
   * Both ends of the stretch of branch history no record accounts for, on a
   * `BASE_DISCONTINUITY`. `from` is the sha the chain stops at and `to` is the
   * sha the next record begins at, so the merges in between are whatever a
   * first-parent walk from `to` passes through before it reaches `from`.
   *
   * The sentence carries the same two shas and a reader can see them there. A
   * program cannot, and the program that heals this gap has to name both ends
   * of it. Reading them back out of English is how a repair tool starts
   * disagreeing with the verifier it takes its instructions from.
   */
  readonly gap?: { readonly from: string; readonly to: string };
}

export interface ChainVerifierPorts {
  /** True when the JWS is a valid signature over these bytes by a published key. */
  verifySignature(jws: string, bytes: Uint8Array): Promise<boolean>;
  /**
   * The first sequence number that is a real record. Anything below it was
   * written before records existed and is reported, not failed.
   */
  epochStartsAt: number;
  /**
   * What this chain was asked for. Optional so an existing caller that has
   * not passed one keeps working: without it, a record's own repository and
   * ref are trusted rather than checked against a request.
   *
   * When present, a parsed record naming a different repository or ref is a
   * finding, not a silent pass — a chain served from the wrong branch must
   * not verify clean just because its own links join up internally.
   */
  subject?: { readonly repositoryId: string; readonly baseRef: string };
  /**
   * Where the branch actually stands right now, from somewhere that is not the
   * chain. Optional for the same reason `subject` is: a caller that cannot get
   * it keeps working, and the walk says nothing about the head rather than
   * guessing.
   *
   * The records catch a merge that was never recorded only when a later merge
   * was recorded, because the later record's `before` names a base the chain
   * never reached. A chain that stops, with the unrecorded merges all sitting
   * after the last record, is internally perfect. Nothing inside it can be
   * compared against anything. The branch's current base sha is the only fact
   * that closes that, and it has to come from the provider, not from thwip:
   * a service asked to report both its chain and the head it is behind would
   * simply report a head that matches.
   */
  head?: { readonly baseSha: string };
}

/**
 * What `verifyChain` learned about a chain: the findings, and how many
 * signatures were actually checked. `signaturesChecked` exists because
 * `epochStartsAt` decides which links get their signature checked at all —
 * an untrusted, too-large `epochStartsAt` makes every readable link skip
 * verification, and that skip produces no finding on its own. A caller that
 * only looked at `findings` being empty would report a clean chain having
 * checked nothing. Returning the count forces every caller to say what it
 * actually checked, not just what it failed to complain about.
 */
export interface ChainVerification {
  readonly findings: readonly ChainFinding[];
  readonly signaturesChecked: number;
  /**
   * Every correction the walk followed, so a reader is told rather than left to
   * notice.
   *
   * Not a finding, and that is a decision. A finding is a defect: something the
   * chain cannot account for. A correction that stands is the chain accounting
   * for a defect, out loud, in signed bytes that name the record, the sha it got
   * wrong, the sha it should have said, who asked and when. Filing it as a
   * problem would mean a chain can never be made whole, which is an argument for
   * quietly rewriting instead. So the count of problems goes to zero and this
   * list is what refuses to let the mistake disappear: the corrected record is
   * still served, still signed, still says what it said.
   */
  readonly corrections: readonly ChainCorrection[];
}

/** One record correcting another, as the walk read it. */
export interface ChainCorrection {
  readonly sequence: number;
  readonly digest: string;
  readonly correctsSequence: number;
  readonly correctsDigest: string;
  /** The sha the corrected record named. */
  readonly from: string;
  /** The sha the branch actually took, as the correction states it. */
  readonly to: string;
  readonly observedAt: string;
  readonly actorPrincipalId: string;
  readonly reason: string;
}

export async function verifyChain(
  links: readonly ChainLink[],
  ports: ChainVerifierPorts,
): Promise<ChainVerification> {
  const findings: ChainFinding[] = [];
  let signaturesChecked = 0;
  let previous: { digest: string; sequence: number | null; afterBaseSha: string | null } | null = null;
  let first = true;
  const edges: Edge[] = [];
  const records = new Map<string, TransitionRecordV1>();
  let unreadable = 0;

  for (const link of links) {
    if (link.bytes.length === 0) {
      unreadable++;
      if (first) findings.push(...anchor(link.sequence ?? null, link.digest, ports));
      first = false;
      const history = link.sequence === undefined || link.sequence < ports.epochStartsAt;
      findings.push(
        history
          ? {
              code: "PRE_ATTESTATION",
              sequence: link.sequence ?? null,
              digest: link.digest,
              detail: "written before signed records; nothing to verify",
            }
          : {
              code: "MISSING_RECORD",
              sequence: link.sequence ?? null,
              digest: link.digest,
              detail: "this link belongs to the attested range and has no record",
            },
      );
      // The digest still anchors what comes next. A link we cannot read must not
      // hide a break in the link after it. Its base sha is unknown, so the link
      // after it is not asked to continue from anywhere.
      previous = { digest: link.digest, sequence: null, afterBaseSha: null };
      continue;
    }

    const parsed = await inspect(link, ports);
    findings.push(...parsed.findings);
    if (parsed.signatureChecked) signaturesChecked++;
    if (first) findings.push(...anchor(parsed.sequence, link.digest, ports));
    first = false;
    if (!parsed.readable) unreadable++;
    if (parsed.record !== null) records.set(link.digest, parsed.record);
    if (parsed.readable && parsed.afterBaseSha !== null) {
      edges.push({
        sequence: parsed.sequence,
        digest: link.digest,
        before: parsed.beforeBaseSha,
        after: parsed.afterBaseSha,
      });
    }

    if (previous !== null && parsed.readable) {
      if (parsed.previousDigest !== previous.digest) {
        findings.push({
          code: "BROKEN_LINK",
          sequence: parsed.sequence,
          digest: link.digest,
          detail: `names ${parsed.previousDigest ?? "nothing"} as its predecessor, which is not the link before it`,
        });
      }
      if (previous.sequence !== null && parsed.sequence !== null && parsed.sequence !== previous.sequence + 1) {
        findings.push({
          code: "SEQUENCE_GAP",
          sequence: parsed.sequence,
          digest: link.digest,
          // Not "a merge landed without a record": this check cannot support
          // that claim. Sequence numbers are handed out per recorded
          // transition, so an unrecorded merge leaves the numbering intact.
          // What a gap says is narrower — records that were written are not in
          // what was served.
          detail: `link ${parsed.sequence} follows ${previous.sequence}; the records in between were written and not served`,
        });
      }
    }
    previous = { digest: link.digest, sequence: parsed.sequence, afterBaseSha: parsed.afterBaseSha };
  }

  const corrected = substitute(records, edges);
  findings.push(...corrected.findings);
  const path = walk(corrected.edges, unreadable);
  findings.push(...path.findings);
  findings.push(...reachesHead(path.endsAt, unreadable, ports));
  return { findings, signaturesChecked, corrections: corrected.corrections };
}

/**
 * Replacing a record's edge with the one that corrects it.
 *
 * A correction is appended, never applied. The bytes of the record it names do
 * not change, so the only place the substitution can happen is here: the
 * corrected record's edge is dropped from the set of moves and the correction's
 * edge stands in its place. Adding the correction's edge alongside would assert
 * a second departure from the same base, which is a worse lie than the one it
 * closes.
 *
 * What the verifier can enforce without asking anything of the network is the
 * whole difference between a correction and a rewrite. A correction restates the
 * cited record's `before`, its tree, its parent vector and its attempt exactly,
 * and changes one field. Anything else and the substitution is refused and the
 * chain reports whatever break it actually has. So the most a signing key can do
 * through this mechanism is rename one commit to another commit that has the
 * same tree, the same parents and the same starting point, and even then only
 * where the route would first ask GitHub which of the two the branch contains.
 *
 * Two corrections of one record are two answers to one question, so neither is
 * followed. A correction naming a record nobody served is unanchored: there is
 * nothing to check it against, and taking its word would let a chain assert a
 * base move on the strength of a record the reader never saw.
 */
function substitute(
  records: ReadonlyMap<string, TransitionRecordV1>,
  edges: readonly Edge[],
): { edges: Edge[]; corrections: ChainCorrection[]; findings: ChainFinding[] } {
  const claims = new Map<string, Array<{ digest: string; record: TransitionRecordV1 }>>();
  for (const [digest, record] of records) {
    if (record.kind !== "base-correction") continue;
    const target = record.correction.correctsTransitionDigest;
    claims.set(target, [...(claims.get(target) ?? []), { digest, record }]);
  }
  if (claims.size === 0) return { edges: [...edges], corrections: [], findings: [] };

  const findings: ChainFinding[] = [];
  const corrections: ChainCorrection[] = [];
  const dropped = new Set<string>();

  for (const [targetDigest, group] of claims) {
    const refuse = (digest: string, sequence: number, detail: string): void => {
      findings.push({ code: "CORRECTION_OVERREACHES", sequence, digest, detail });
      dropped.add(digest);
    };

    if (group.length > 1) {
      for (const c of group) {
        refuse(
          c.digest,
          c.record.transitionSequence,
          `records ${group.map((g) => g.record.transitionSequence).join(" and ")} both correct ${targetDigest}; ` +
            `two answers to one question, so neither is followed`,
        );
      }
      continue;
    }

    const { digest, record } = group[0] as { digest: string; record: TransitionRecordV1 };
    if (record.kind !== "base-correction") continue;
    const facts = record.correction;
    const target = records.get(targetDigest);
    if (target === undefined) {
      findings.push({
        code: "CORRECTION_UNANCHORED",
        sequence: record.transitionSequence,
        digest,
        detail: `corrects ${targetDigest}, which is not a record this chain served; there is nothing to check it against`,
      });
      dropped.add(digest);
      continue;
    }

    const complaint = overreach(record, facts, target);
    if (complaint !== null) {
      refuse(digest, record.transitionSequence, complaint);
      continue;
    }

    dropped.add(targetDigest);
    corrections.push({
      sequence: record.transitionSequence,
      digest,
      correctsSequence: target.transitionSequence,
      correctsDigest: targetDigest,
      from: facts.correctedBaseSha,
      to: record.after.baseSha,
      observedAt: record.observedAt,
      actorPrincipalId: facts.actorPrincipalId,
      reason: facts.reason,
    });
  }

  return { edges: edges.filter((e) => !dropped.has(e.digest)), corrections, findings };
}

/** Everything a correction is not allowed to change, said as the sentence it fails. */
function overreach(
  correction: TransitionRecordV1,
  facts: { correctedBaseSha: string; attemptId: string; correctsTransitionSequence: number },
  target: TransitionRecordV1,
): string | null {
  if (target.transitionSequence !== facts.correctsTransitionSequence) {
    return `cites record ${facts.correctsTransitionSequence}, but that digest is record ${target.transitionSequence}`;
  }
  if (target.repositoryId !== correction.repositoryId || target.baseRef !== correction.baseRef) {
    return "corrects a record from another repository or branch";
  }
  if (target.after.baseSha !== facts.correctedBaseSha) {
    return `says record ${target.transitionSequence} names ${facts.correctedBaseSha}, and it names ${target.after.baseSha}`;
  }
  if (target.before.baseSha !== correction.before.baseSha || target.before.treeOid !== correction.before.treeOid) {
    return "moves where the record it corrects began; a correction may only change the sha the base became";
  }
  if (
    target.after.treeOid !== correction.after.treeOid ||
    target.after.parentCount !== correction.after.parentCount ||
    target.after.parentOidsDigest !== correction.after.parentOidsDigest ||
    target.after.parentOids.length !== correction.after.parentOids.length ||
    target.after.parentOids.some((oid, i) => oid !== correction.after.parentOids[i])
  ) {
    return "changes the tree or the parents the record certified; that is a different commit, not another name for one";
  }
  const attempt = attemptOf(target);
  if (attempt !== null && attempt !== facts.attemptId) {
    return `names attempt ${facts.attemptId}, and the record it corrects was merged by ${attempt}`;
  }
  return null;
}

/** The attempt a record cites, where its kind cites one. */
function attemptOf(record: TransitionRecordV1): string | null {
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

/**
 * One record, read as a move of the base from one sha to another. `before` is
 * null on the record that opened the chain: it began at no base, which makes it
 * the one place a walk can start without asking what came before.
 */
interface Edge {
  readonly sequence: number | null;
  readonly digest: string;
  readonly before: string | null;
  readonly after: string;
}

/**
 * Following the shas, because log order stopped being history order.
 *
 * A merge recorded after later records must be appended at the head because the
 * chain is append-only and hash-linked. Comparing each record only with the one
 * printed before it can therefore call a complete chain broken.
 *
 * Continuity is therefore a property of the set of moves. Each record is an
 * edge from `before.baseSha` to `after.baseSha`, and a chain holds when those
 * edges form a single path. The walk discovers the order rather than assuming
 * the log carries it.
 *
 * The property that matters is untouched: a base sha that no record moves away
 * from, with records still unaccounted for, is a merge nobody wrote down. The
 * walk still stops at the missing edge and reports the stranded later record.
 */
function walk(edges: readonly Edge[], unreadable: number): { findings: ChainFinding[]; endsAt: Edge | null } {
  const forks = forked(edges);
  if (forks.length > 0) return { findings: forks, endsAt: null };

  const out = new Map<string, Edge>();
  for (const e of edges) if (e.before !== null) out.set(e.before, e);

  const findings: ChainFinding[] = [];
  const remaining = new Set(edges);
  let last: Edge | null = null;
  let stops = 0;
  while (remaining.size > 0) {
    const start = root(remaining);
    if (last !== null) {
      findings.push({
        code: "BASE_DISCONTINUITY",
        sequence: start.sequence,
        digest: start.digest,
        ...(start.before === null ? {} : { gap: { from: last.after, to: start.before } }),
        detail:
          `the base stops at ${last.after}: no record moves it from there, and record ` +
          `${start.sequence ?? "?"} begins further on at ${start.before ?? "no base at all"}; ` +
          `the merge in between was never recorded`,
      });
      stops++;
    }
    let step: Edge | undefined = start;
    while (step !== undefined && remaining.has(step)) {
      remaining.delete(step);
      last = step;
      // A visited edge ends the walk rather than repeating it. Shas are derived
      // from content, so a cycle takes forged records, and the edges it strands
      // are reported as the break they look like from here.
      step = out.get(step.after);
    }
  }

  // A record that was not served leaves an edge nobody can see, and the walk
  // stops at its start looking exactly like a merge that went unrecorded. That
  // link is already reported, as MISSING_RECORD or PRE_ATTESTATION, so a second
  // accusation drawn from an incomplete set of records says nothing new and can
  // be wrong. More stops than withheld records means at least one is real, and
  // there is no way to say which, so all of them are shown.
  if (stops > 0 && stops <= unreadable) return { findings: [], endsAt: last };
  return { findings, endsAt: last };
}

/**
 * Two records leaving the same base.
 *
 * The branch cannot have moved off one sha two different ways, so one of the
 * two describes a merge that did not happen here. This is only visible from the
 * edges: down the log the two sit at different positions and each looks fine
 * beside its own neighbour. Reported rather than resolved, because picking
 * which of the two to follow would be inventing the answer.
 */
function forked(edges: readonly Edge[]): ChainFinding[] {
  const byBase = new Map<string, Edge[]>();
  for (const e of edges) {
    if (e.before === null) continue;
    byBase.set(e.before, [...(byBase.get(e.before) ?? []), e]);
  }
  const findings: ChainFinding[] = [];
  for (const [base, group] of byBase) {
    if (group.length < 2) continue;
    const [, second] = group;
    findings.push({
      code: "FORKED_BASE",
      sequence: second?.sequence ?? null,
      digest: second?.digest ?? "",
      detail:
        `records ${group.map((e) => e.sequence ?? "?").join(" and ")} both move the base off ${base}; ` +
        `the branch left it once, so one of them did not happen on this branch`,
    });
  }
  return findings;
}

/**
 * Where to start walking a set of records: the one whose base nothing else in
 * the set reaches. Ties and cycles fall back to the lowest sequence, which is
 * the earliest thing written and the only ordering left that means anything.
 */
function root(edges: ReadonlySet<Edge>): Edge {
  const arrivals = new Set([...edges].map((e) => e.after));
  const ordered = [...edges].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return ordered.find((e) => e.before === null || !arrivals.has(e.before)) ?? (ordered[0] as Edge);
}

/**
 * Whether the chain ends where the branch actually stands.
 *
 * `BASE_DISCONTINUITY` catches an unrecorded merge only once a later merge is
 * recorded. Everything that landed after the final record is invisible from
 * inside the chain, and it is the likeliest place for a merge to go missing:
 * the record is written after the merge, so a crash between the two leaves
 * exactly this shape.
 *
 * Nothing is claimed without the caller's head. Silence when it is absent, and
 * silence when the last link could not be read, because "the last record is
 * gone" is already reported as `MISSING_RECORD` and has no base sha to compare.
 * An empty chain is not accused either: a repository that has merged nothing
 * and a repository whose every record was withheld look the same from here,
 * and the caller's own "nothing was verified" verdict already covers it.
 */
function reachesHead(last: Edge | null, unreadable: number, ports: ChainVerifierPorts): ChainFinding[] {
  if (ports.head === undefined || last === null || unreadable > 0) return [];
  if (last.after === ports.head.baseSha) return [];
  return [
    {
      code: "CHAIN_BEHIND_HEAD",
      sequence: last.sequence,
      digest: last.digest,
      detail:
        `the last record leaves the base at ${last.after}, but the branch stands at ` +
        `${ports.head.baseSha}; the base moved after the chain ended and no record says how`,
    },
  ];
}

/**
 * Where a served chain is allowed to begin.
 *
 * The rule: the first link's sequence must not be above `epochStartsAt`, or it
 * must be sequence 1. It is the start of the chain, the first attested record,
 * or history sitting below it.
 *
 * Sequence 1 anchors on its own because the record schema binds it to a null
 * predecessor. There is no earlier link, so a server serving from it has
 * withheld nothing, whatever `epochStartsAt` says. A queue that has never
 * rebaselined sits at epoch 0 and opens its chain at 1, and without this clause
 * every repository in that state reported a prefix it could never have had.
 *
 * Nothing used to anchor the start. `previous` began null, so the first link's
 * predecessor digest and sequence were compared against nothing, and a real
 * three-link chain served as links 2 and 3 came back with no findings and two
 * links verified. A server suppressing every override-merge in the first k
 * links just served from k+1 and no reader could tell.
 *
 * One comparison covers both halves of that. `parseTransitionRecord` already
 * binds sequence 1 to a null predecessor and every other sequence to a
 * non-null one, so a first link above the epoch is exactly a first link whose
 * named predecessor sits inside the attested range and was not served — a
 * predecessor that should have been checkable and was withheld. Below the
 * epoch the predecessor predates signed records, which is history rather than
 * suppression, and a chain adopted at sequence 22 with `epochStartsAt` 22
 * anchors cleanly.
 *
 * What is left over is a server that raises `epochStartsAt` to match wherever
 * it chose to start. That claim is printed on every run and `--epoch` refutes
 * it, which is the only place outside the service where it can be refuted.
 *
 * A link whose position is unknown (`sequence` absent, bytes unreadable) is
 * not judged: "written before positions were recorded" must not be turned into
 * an accusation.
 */
function anchor(sequence: number | null, digest: string, ports: ChainVerifierPorts): ChainFinding[] {
  if (sequence === null || sequence === 1 || sequence <= ports.epochStartsAt) return [];
  return [
    {
      code: "MISSING_PREFIX",
      sequence,
      digest,
      detail:
        `the chain starts at link ${sequence}, inside the attested range that begins at ` +
        `${ports.epochStartsAt}; the links before it were not served and cannot be checked`,
    },
  ];
}

async function inspect(
  link: ChainLink,
  ports: ChainVerifierPorts,
): Promise<{
  readable: boolean;
  sequence: number | null;
  previousDigest: string | null;
  beforeBaseSha: string | null;
  afterBaseSha: string | null;
  signatureChecked: boolean;
  record: TransitionRecordV1 | null;
  findings: ChainFinding[];
}> {
  const findings: ChainFinding[] = [];
  const actual = await envelopeDigest(link.bytes);
  if (actual !== link.digest) {
    findings.push({
      code: "DIGEST_MISMATCH",
      sequence: null,
      digest: link.digest,
      detail: `these bytes digest to ${actual}`,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(link.bytes));
  } catch {
    findings.push({ code: "UNPARSEABLE", sequence: null, digest: link.digest, detail: "not JSON" });
    return {
      readable: false,
      sequence: null,
      previousDigest: null,
      beforeBaseSha: null,
      afterBaseSha: null,
      signatureChecked: false,
      record: null,
      findings,
    };
  }

  const record = parseTransitionRecord(value);
  if (!record.ok) {
    findings.push({ code: "UNPARSEABLE", sequence: null, digest: link.digest, detail: record.detail });
    return {
      readable: false,
      sequence: null,
      previousDigest: null,
      beforeBaseSha: null,
      afterBaseSha: null,
      signatureChecked: false,
      record: null,
      findings,
    };
  }

  if (
    ports.subject !== undefined &&
    (record.value.repositoryId !== ports.subject.repositoryId || record.value.baseRef !== ports.subject.baseRef)
  ) {
    findings.push({
      code: "WRONG_SUBJECT",
      sequence: record.value.transitionSequence,
      digest: link.digest,
      detail: `names ${record.value.repositoryId}@${record.value.baseRef}, not the branch this chain was requested for`,
    });
  }

  // A genesis says a chain starts here, so it belongs where the attested range
  // starts and nowhere else. One inside the range would claim a second root and
  // split what a reader is asked to trust into two chains presented as one.
  if (record.value.kind === "genesis" && record.value.transitionSequence !== ports.epochStartsAt) {
    findings.push({
      code: "GENESIS_MISPLACED",
      sequence: record.value.transitionSequence,
      digest: link.digest,
      detail: `opens a chain at ${record.value.transitionSequence}, and the attested range starts at ${ports.epochStartsAt}`,
    });
  }

  let signatureChecked = false;
  if (record.value.transitionSequence >= ports.epochStartsAt) {
    signatureChecked = true;
    const signed = await ports.verifySignature(link.jws, link.bytes);
    if (!signed) {
      findings.push({
        code: "BAD_SIGNATURE",
        sequence: record.value.transitionSequence,
        digest: link.digest,
        detail: "no published key verifies this record",
      });
    }
  }

  return {
    readable: true,
    sequence: record.value.transitionSequence,
    previousDigest: record.value.previousTransitionDigest,
    beforeBaseSha: record.value.before.baseSha,
    afterBaseSha: record.value.after.baseSha,
    signatureChecked,
    record: record.value,
    findings,
  };
}
