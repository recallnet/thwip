import { describe, expect, it } from "vitest";
import { canonicalBytes, envelopeDigest } from "./canonical.js";
import { verifyChain, type ChainLink } from "./verify-chain.js";
import { D, HEAD, baseAt, link, makeLink, signedOk, treeAt } from "./test/verify-chain-fixtures.js";

/**
 * Walking a branch's chain and saying whether it holds.
 *
 * Until this existed the chain was a claim. Records were signed and stored and
 * nothing ever checked that the links joined up, that a digest named its own
 * bytes, or that the signature was real. The first two merges to land without a
 * record went unnoticed for exactly that reason, and a third went unnoticed
 * after that, because a record nobody wrote leaves the numbering and the digests
 * intact. Only the base sha moves.
 *
 * Pure on purpose. Signature checking is injected so this runs unchanged in the
 * Worker, in the CLI, and here.
 *
 * `link`, `makeLink`, `baseAt` and friends live in `./test/verify-chain-fixtures.js`
 * so `chain-self-check.test.ts` in the control plane can build the same chains
 * without a second, drifting copy.
 */

describe("verifying a chain", () => {
  it("accepts a chain whose links join up", async () => {
    const one = await link(1, null);
    const two = await link(2, one.digest);
    const result = await verifyChain([one, two], signedOk);
    expect(result.findings).toEqual([]);
    expect(result.signaturesChecked).toBe(2);
  });

  /**
   * A chain that carries a merge under `fresh`. Its record is a different kind
   * with a different facts block, and a walk that only knew the reuse shape
   * would stop dead on a real chain the moment one landed.
   */
  it("walks a chain containing a verified merge", async () => {
    const one = await link(1, null);
    const two = await makeLink({
      sequence: 2,
      previous: one.digest,
      over: {
        kind: "verified-merge",
        reusedProof: undefined,
        verifiedMerge: {
          attemptId: "att-2",
          mergeIntentDigest: D("1"),
          pullRequestNumber: 2,
          headSha: HEAD,
          candidateSha: baseAt(2),
          candidateTreeOid: treeAt(2),
          mergeMethod: "merge",
          workReceiptDigest: D("2"),
          assignmentDigest: D("3"),
          integrationEvidenceDigest: D("4"),
          policyDigest: D("6"),
          pipelineDigest: D("8"),
          requiredSuitesDigest: D("9"),
          execution: { ranOn: "device", deviceKeyId: "SHA256:abc" },
        },
      },
    });
    const result = await verifyChain([one, two], signedOk);
    expect(result.findings).toEqual([]);
    expect(result.signaturesChecked).toBe(2);
  });

  it("reports a digest that does not name its own bytes", async () => {
    const one = await link(1, null);
    const tampered = { ...one, digest: D("0") };
    const { findings } = await verifyChain([tampered], signedOk);
    expect(findings.map((f) => f.code)).toContain("DIGEST_MISMATCH");
  });

  it("reports a link that names the wrong predecessor", async () => {
    const one = await link(1, null);
    const two = await link(2, D("0"));
    const { findings } = await verifyChain([one, two], signedOk);
    expect(findings.map((f) => f.code)).toContain("BROKEN_LINK");
  });

  /** The failure that actually happened: two merges landed and wrote no record. */
  it("reports a gap where a sequence number is missing", async () => {
    const one = await link(1, null);
    const three = await link(3, one.digest);
    const { findings } = await verifyChain([one, three], signedOk);
    expect(findings.map((f) => f.code)).toContain("SEQUENCE_GAP");
  });

  /**
   * A failure the sequence check cannot see.
   *
   * A merge landed as a1fe3e7 and wrote no record. Record 52 left the base at
   * 7059839; record 53 says it began at a1fe3e7, whose parent is 7059839.
   * Sequence numbers are handed out per recorded transition, so an unrecorded
   * merge leaves no hole: 53 follows 52 and every existing check agrees.
   * The move from 7059839 to a1fe3e7 is the merge nobody wrote down, and the
   * two records already carry both ends of it.
   */
  describe("a base that moved between two records", () => {
    const fiftyTwoBefore = "797c695e4f7965b5592802a4e513fbd9e5982fa2";
    const fiftyTwoAfter = "7059839f29bf1aa0c0dd55e4e004cd64c155ba99";
    const unrecorded = "a1fe3e7e32aed7eaeefe799174d5c4962331ac40";
    const fiftyThreeAfter = "a5f50bacb82ee5fc16de2efc73d320c7deff30fe";
    const atEpoch = { verifySignature: async () => true, epochStartsAt: 52 };

    it("reports the merge that landed between record 52 and record 53", async () => {
      const fiftyTwo = await makeLink({
        sequence: 52,
        previous: D("a"),
        before: fiftyTwoBefore,
        after: fiftyTwoAfter,
        head: "aaff7ce48dc0eb613ae11d2291ae1cebc137febe",
      });
      const fiftyThree = await makeLink({
        sequence: 53,
        previous: fiftyTwo.digest,
        before: unrecorded,
        after: fiftyThreeAfter,
        head: "e9bc094f8a436cbfd9744b3ae5e94f1b0ed69541",
      });
      const { findings } = await verifyChain([fiftyTwo, fiftyThree], atEpoch);
      expect(findings.map((f) => f.code)).toEqual(["BASE_DISCONTINUITY"]);
      expect(findings[0]?.detail).toContain(fiftyTwoAfter);
      expect(findings[0]?.detail).toContain(unrecorded);
    });

    /**
     * The two shas a reader needs are in the sentence, and a sentence is not
     * something another program can act on. Whoever repairs this gap has to
     * name both ends of it, and parsing them back out of English is how a
     * repair tool starts disagreeing with the verifier it reads from.
     */
    it("names both ends of the gap in fields, not only in the sentence", async () => {
      const fiftyTwo = await makeLink({
        sequence: 52,
        previous: D("a"),
        before: fiftyTwoBefore,
        after: fiftyTwoAfter,
        head: "aaff7ce48dc0eb613ae11d2291ae1cebc137febe",
      });
      const fiftyThree = await makeLink({
        sequence: 53,
        previous: fiftyTwo.digest,
        before: unrecorded,
        after: fiftyThreeAfter,
        head: "e9bc094f8a436cbfd9744b3ae5e94f1b0ed69541",
      });
      const { findings } = await verifyChain([fiftyTwo, fiftyThree], atEpoch);
      expect(findings[0]?.gap).toEqual({ from: fiftyTwoAfter, to: unrecorded });
    });

    it("says nothing when record 53 begins where record 52 ended", async () => {
      const fiftyTwo = await makeLink({
        sequence: 52,
        previous: D("a"),
        before: fiftyTwoBefore,
        after: fiftyTwoAfter,
      });
      const fiftyThree = await makeLink({
        sequence: 53,
        previous: fiftyTwo.digest,
        before: fiftyTwoAfter,
        after: fiftyThreeAfter,
      });
      const { findings } = await verifyChain([fiftyTwo, fiftyThree], atEpoch);
      expect(findings).toEqual([]);
    });

    it("does not accuse a link whose predecessor could not be read", async () => {
      const unreadable: ChainLink = { digest: D("a"), bytes: new Uint8Array(), jws: "", sequence: 52 };
      const fiftyThree = await makeLink({ sequence: 53, previous: D("a"), before: unrecorded, after: fiftyThreeAfter });
      const { findings } = await verifyChain([unreadable, fiftyThree], atEpoch);
      expect(findings.map((f) => f.code)).not.toContain("BASE_DISCONTINUITY");
    });
  });

  /**
   * A repaired chain with merges recorded after the fact.
   *
   * Several merges landed with no record. They were recorded afterwards by a route
   * that appends, and the chain is hash-linked, so the four could only land at
   * the head as 55, 56, 57 and 58, never back where the merges happened. Log
   * order stopped being history order at that moment.
   *
   * Following the shas instead of the numbers gives one unbroken path: 46 ends
   * at 3aa327e, 55 and 56 carry it to de6c17b where 47 begins, 51 ends at
   * a8d9874 where 57 begins, 57 hands 797c695 to 52, and 58 carries 52's
   * 7059839 to a1fe3e7 where 53 begins. Every edge exists.
   */
  describe("a chain repaired at the head", () => {
    const atEpoch = { verifySignature: async () => true, epochStartsAt: 46 };
    const fortySixBefore = "ff6ea882feefd64c4e9f4dff909209e7adb281e3";
    const fortySixAfter = "3aa327edeedf758f73fc7feb74a903818932e808";
    const fiftyFiveAfter = "5ce265c39c1a6ec0f6a0c0c7e5f5bb0b1c4b4a20";
    const fortySevenBefore = "de6c17b4aff35fc1cca82a18e1d3d4df24eb5876";
    const fiftyOneAfter = "a8d9874941bc5cbaabd52c3f7e18489dab206400";
    const fiftyTwoBefore = "797c695e4f7965b5592802a4e513fbd9e5982fa2";
    const fiftyTwoAfter = "7059839f29bf1aa0c0dd55e4e004cd64c155ba99";
    const fiftyThreeBefore = "a1fe3e7e32aed7eaeefe799174d5c4962331ac40";

    /**
     * Records 46 to 58 in the order the log holds them, with the live shas at
     * every seam the repair touched and `baseAt` filling the stretches it did
     * not. Each link names the digest of the link before it in log order,
     * because that is how they were written.
     */
    async function repaired(): Promise<ChainLink[]> {
      const shape = (sequence: number, before: string, after: string) => ({ sequence, before, after });
      const shapes = [
        shape(46, fortySixBefore, fortySixAfter),
        shape(47, fortySevenBefore, baseAt(47)),
        shape(48, baseAt(47), baseAt(48)),
        shape(49, baseAt(48), baseAt(49)),
        shape(50, baseAt(49), baseAt(50)),
        shape(51, baseAt(50), fiftyOneAfter),
        shape(52, fiftyTwoBefore, fiftyTwoAfter),
        shape(53, fiftyThreeBefore, baseAt(53)),
        shape(54, baseAt(53), baseAt(54)),
        shape(55, fortySixAfter, fiftyFiveAfter),
        shape(56, fiftyFiveAfter, fortySevenBefore),
        shape(57, fiftyOneAfter, fiftyTwoBefore),
        shape(58, fiftyTwoAfter, fiftyThreeBefore),
      ];
      const links: ChainLink[] = [];
      let previous = D("a");
      for (const s of shapes) {
        const built = await makeLink({ ...s, previous });
        previous = built.digest;
        links.push({ ...built, sequence: s.sequence });
      }
      return links;
    }

    it("accepts the repaired chain, whose edges form one unbroken path", async () => {
      const { findings } = await verifyChain(await repaired(), atEpoch);
      expect(findings).toEqual([]);
    });

    it("still reports the hole when the merge record is not there", async () => {
      const links = (await repaired()).filter((l) => l.sequence !== 58);
      const { findings } = await verifyChain(links, atEpoch);
      expect(findings.map((f) => f.code)).toEqual(["BASE_DISCONTINUITY"]);
      expect(findings[0]?.sequence).toBe(53);
      expect(findings[0]?.detail).toContain(fiftyTwoAfter);
      expect(findings[0]?.detail).toContain(fiftyThreeBefore);
    });

    it("reports every hole when more than one record is missing", async () => {
      const links = (await repaired()).filter((l) => l.sequence !== 57 && l.sequence !== 58);
      const { findings } = await verifyChain(links, atEpoch);
      expect(findings.map((f) => f.code)).toEqual(["BASE_DISCONTINUITY", "BASE_DISCONTINUITY"]);
      expect(findings.map((f) => f.sequence)).toEqual([52, 53]);
    });

    it("judges the branch head against where the path ends, not the last link written", async () => {
      const links = await repaired();
      const clean = await verifyChain(links, { ...atEpoch, head: { baseSha: baseAt(54) } });
      expect(clean.findings).toEqual([]);
      const behind = await verifyChain(links, { ...atEpoch, head: { baseSha: fortySixAfter } });
      expect(behind.findings.map((f) => f.code)).toEqual(["CHAIN_BEHIND_HEAD"]);
      expect(behind.findings[0]?.detail).toContain(baseAt(54));
    });
  });

  /**
   * What the edge view can see that a walk down the log could not. Two records
   * leaving the same base is a fork: the branch cannot have moved off one sha
   * two different ways, so one of the two records is describing a merge that
   * did not happen on this branch. Following the shas has to pick one of the
   * two to continue from, and there is no honest way to pick, so the ambiguity
   * itself is what gets reported.
   */
  describe("two records leaving the same base", () => {
    it("reports a fork instead of choosing a side", async () => {
      const one = await makeLink({ sequence: 1, previous: null });
      const two = await makeLink({ sequence: 2, previous: one.digest });
      const rival = await makeLink({ sequence: 3, previous: two.digest, before: baseAt(1), after: baseAt(9) });
      const { findings } = await verifyChain([one, two, rival], signedOk);
      expect(findings.map((f) => f.code)).toEqual(["FORKED_BASE"]);
      expect(findings[0]?.detail).toContain(baseAt(1));
    });
  });

  /**
   * A chain that simply stops cannot be caught from the records alone: the last
   * record is consistent with everything before it, and the merges after it left
   * no trace inside the chain. Only the branch's current base, which the caller
   * has to fetch from somewhere that is not thwip, says the chain is behind.
   */
  describe("checking the chain against the branch head", () => {
    it("reports a chain whose last record does not reach the branch head", async () => {
      const one = await link(1, null);
      const two = await link(2, one.digest);
      const { findings } = await verifyChain([one, two], {
        ...signedOk,
        head: { baseSha: "a1fe3e7e32aed7eaeefe799174d5c4962331ac40" },
      });
      expect(findings.map((f) => f.code)).toContain("CHAIN_BEHIND_HEAD");
    });

    it("passes when the last record ends on the branch head", async () => {
      const one = await link(1, null);
      const two = await link(2, one.digest);
      const { findings } = await verifyChain([one, two], { ...signedOk, head: { baseSha: baseAt(2) } });
      expect(findings).toEqual([]);
    });

    it("is silent about the head when no caller supplied one", async () => {
      const one = await link(1, null);
      const { findings } = await verifyChain([one], signedOk);
      expect(findings.map((f) => f.code)).not.toContain("CHAIN_BEHIND_HEAD");
    });

    it("does not judge a head against a last link it could not read", async () => {
      const one = await link(1, null);
      const gone: ChainLink = { digest: D("a"), bytes: new Uint8Array(), jws: "", sequence: 2 };
      const { findings } = await verifyChain([one, gone], { ...signedOk, head: { baseSha: baseAt(9) } });
      expect(findings.map((f) => f.code)).not.toContain("CHAIN_BEHIND_HEAD");
    });
  });

  it("reports a signature that does not verify", async () => {
    const one = await link(1, null);
    const { findings } = await verifyChain([one], { verifySignature: async () => false, epochStartsAt: 1 });
    expect(findings.map((f) => f.code)).toContain("BAD_SIGNATURE");
  });

  /**
   * `epochStartsAt` decides which links get their signature checked at all.
   * A huge `epochStartsAt` — trusted from the server when no `--epoch` pins
   * it — makes every readable link skip verification, and that skip raises
   * no finding by itself. `signaturesChecked` is how a caller can tell "zero
   * signatures were checked" apart from "every signature checked out".
   */
  it("reports zero signatures checked when epochStartsAt skips every readable link", async () => {
    const one = await link(1, null);
    const two = await link(2, one.digest);
    const result = await verifyChain([one, two], { verifySignature: async () => true, epochStartsAt: 999_999_999 });
    expect(result.findings).toEqual([]);
    expect(result.signaturesChecked).toBe(0);
  });

  /**
   * The hole this closes: nothing anchored the first link, so a server could
   * serve a real chain from its second link and the walk had nothing to compare
   * the start against. Three real links served as links 2 and 3 returned no
   * findings at all, which is how every merge before a chosen point gets
   * suppressed without leaving a trace.
   */
  it("reports a chain served from its second link as a missing prefix", async () => {
    const one = await link(1, null);
    const two = await link(2, one.digest);
    const three = await link(3, two.digest);
    const result = await verifyChain([two, three], signedOk);
    expect(result.findings.map((f) => f.code)).toContain("MISSING_PREFIX");
    expect(one.digest).not.toBe(two.digest);
  });

  /**
   * A repository that has never been rebaselined sits at queue epoch 0, and its
   * chain opens at sequence 1. Every fixture here passed `epochStartsAt: 1`, so
   * nothing exercised that pair and a complete two-link chain could report
   * `MISSING_PREFIX`. Sequence 1 is
   * where a chain starts: the record schema binds it to a null predecessor, so
   * there is no earlier link a server could have withheld.
   */
  it("accepts a chain that opens at sequence 1 on a queue that has never rebaselined", async () => {
    const one = await link(1, null);
    const two = await link(2, one.digest);
    const result = await verifyChain([one, two], { verifySignature: async () => true, epochStartsAt: 0 });
    expect(result.findings).toEqual([]);
    expect(result.signaturesChecked).toBe(2);
  });

  it("accepts a first link that sits at the epoch and names pre-attestation history", async () => {
    const twentyTwo = await link(22, D("a"));
    const twentyThree = await link(23, twentyTwo.digest);
    const { findings } = await verifyChain([twentyTwo, twentyThree], {
      verifySignature: async () => true,
      epochStartsAt: 22,
    });
    expect(findings).toEqual([]);
  });

  it("reports bytes that are not a record at all", async () => {
    const junk: ChainLink = {
      digest: await envelopeDigest(canonicalBytes("{}")),
      bytes: canonicalBytes("{}"),
      jws: "signature",
    };
    const { findings } = await verifyChain([junk], signedOk);
    expect(findings.map((f) => f.code)).toContain("UNPARSEABLE");
  });

  /**
   * Links written before records existed are padded commit ids. They are history,
   * not forgery, and a verifier that cannot tell the two apart is useless on any
   * repository that predates the change.
   */
  it("calls pre-epoch links out separately instead of failing them", async () => {
    const old: ChainLink = { digest: D("a"), bytes: new Uint8Array(), jws: "" };
    const { findings } = await verifyChain([old], { verifySignature: async () => false, epochStartsAt: 2 });
    expect(findings.map((f) => f.code)).toEqual(["PRE_ATTESTATION"]);
  });

  it("reports a break that follows a pre-attestation link", async () => {
    const old: ChainLink = { digest: D("a"), bytes: new Uint8Array(), jws: "" };
    const five = await link(5, D("0"));
    const { findings } = await verifyChain([old, five], { verifySignature: async () => true, epochStartsAt: 1 });
    expect(findings.map((f) => f.code)).toContain("BROKEN_LINK");
  });

  it("reports a break that follows a link that could not be read", async () => {
    const junk: ChainLink = {
      digest: await envelopeDigest(canonicalBytes("{}")),
      bytes: canonicalBytes("{}"),
      jws: "signature",
    };
    const two = await link(2, D("0"));
    const { findings } = await verifyChain([junk, two], signedOk);
    expect(findings.map((f) => f.code)).toContain("BROKEN_LINK");
  });

  it("reports a missing record for an empty link inside the attested range", async () => {
    const gone: ChainLink = { digest: D("a"), bytes: new Uint8Array(), jws: "", sequence: 47 };
    const { findings } = await verifyChain([gone], { verifySignature: async () => true, epochStartsAt: 42 });
    // Two separate facts: no record sits where one belongs, and the chain was
    // served starting five links into the attested range.
    expect(findings.map((f) => f.code)).toContain("MISSING_RECORD");
    expect(findings.map((f) => f.code)).toContain("MISSING_PREFIX");
  });

  it("does not invent a gap across a link whose position is unknown", async () => {
    const old: ChainLink = { digest: D("a"), bytes: new Uint8Array(), jws: "" };
    const nine = await link(9, D("a"));
    const { findings } = await verifyChain([old, nine], { verifySignature: async () => true, epochStartsAt: 1 });
    expect(findings.map((f) => f.code)).not.toContain("SEQUENCE_GAP");
    expect(findings.map((f) => f.code)).not.toContain("BROKEN_LINK");
  });

  /**
   * Every record carries the repository and ref it belongs to. Without a check
   * against what was actually requested, a chain served from a different
   * branch — or a different repository — verifies clean as long as its own
   * links join up internally.
   */
  describe("checking the subject", () => {
    it("passes when the requested subject matches every record", async () => {
      const one = await link(1, null);
      const { findings } = await verifyChain([one], {
        ...signedOk,
        subject: { repositoryId: "1315419165", baseRef: "refs/heads/main" },
      });
      expect(findings.map((f) => f.code)).not.toContain("WRONG_SUBJECT");
    });

    it("reports a record naming a different branch than the one requested", async () => {
      const one = await link(1, null);
      const { findings } = await verifyChain([one], {
        ...signedOk,
        subject: { repositoryId: "1315419165", baseRef: "refs/heads/other" },
      });
      expect(findings.map((f) => f.code)).toContain("WRONG_SUBJECT");
    });

    it("reports a record naming a different repository than the one requested", async () => {
      const one = await link(1, null);
      const { findings } = await verifyChain([one], {
        ...signedOk,
        subject: { repositoryId: "999", baseRef: "refs/heads/main" },
      });
      expect(findings.map((f) => f.code)).toContain("WRONG_SUBJECT");
    });

    it("is silent about the subject when none was requested, for existing callers", async () => {
      const one = await link(1, null);
      const { findings } = await verifyChain([one], signedOk);
      expect(findings.map((f) => f.code)).not.toContain("WRONG_SUBJECT");
    });
  });
});

/**
 * A genesis says a chain starts here. Where "here" is belongs to the reader's
 * epoch, and the parser cannot see it, so this is where the two are held
 * together. A second root inside an attested range would split what a reader is
 * asked to check into two chains presented as one.
 */
describe("a root has to be at the start of the range", () => {
  const rootAt = async (sequence: number, previous: string | null) =>
    makeLink({
      sequence,
      previous,
      before: undefined,
      over: {
        kind: "genesis",
        before: { baseSha: null, treeOid: null },
        reusedProof: undefined,
        genesis: {
          policyDigest: D("a"),
          configDigest: D("b"),
          rulesetDigest: D("c"),
          priorEpochClosingDigest: previous,
        },
      },
    });

  it("is silent about a genesis that sits where the range starts", async () => {
    const root = await rootAt(1, null);
    const { findings } = await verifyChain([root], { ...signedOk, epochStartsAt: 1 });
    expect(findings.map((f) => f.code)).not.toContain("GENESIS_MISPLACED");
  });

  it("reports a genesis inside the range rather than at its start", async () => {
    const one = await link(1, null);
    const two = await rootAt(2, one.digest);
    const { findings } = await verifyChain([one, two], { ...signedOk, epochStartsAt: 1 });
    expect(findings.map((f) => f.code)).toContain("GENESIS_MISPLACED");
  });
});
