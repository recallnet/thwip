import { canonicalBytes, envelopeDigest } from "../canonical.js";
import type { ChainLink, ChainVerifierPorts } from "../verify-chain.js";

/**
 * Chain link builders, shared between `verify-chain.test.ts` and any other
 * suite that needs a chain to check.
 *
 * Extracted rather than left local to one test file: `chain-self-check.ts`
 * in the control plane needs a chain that joins up and a chain with a base
 * discontinuity to prove it reads its own chain honestly, and a second
 * hand-written fixture would drift from the one `verifyChain` is actually
 * tested against.
 */

export const HEAD = "2".repeat(40);
export const D = (c: string) => `sha256:${c.repeat(64)}`;

/**
 * Where the base stands after `n` recorded transitions, and the tree it
 * carries. A chain built from these joins up the way a real one does: each
 * link begins at the sha the link before it ended on. Building every link
 * from one constant `before` and one constant `after` made every fixture
 * chain discontinuous, which is the exact defect the walk is meant to catch,
 * so a fixture that does it cannot be used to test for it.
 */
export const baseAt = (n: number) => `ba5e${n.toString(16).padStart(36, "0")}`;
export const treeAt = (n: number) => `47ee${n.toString(16).padStart(36, "0")}`;

export interface Shape {
  readonly sequence: number;
  readonly previous: string | null;
  /** The base this link starts from. Defaults to where link `sequence - 1` ended. */
  readonly before?: string;
  /** The base this link leaves behind. */
  readonly after?: string;
  readonly head?: string;
  readonly over?: Record<string, unknown>;
}

export async function makeLink(shape: Shape): Promise<ChainLink> {
  const { sequence, previous } = shape;
  const before = shape.before ?? baseAt(sequence - 1);
  const after = shape.after ?? baseAt(sequence);
  const head = shape.head ?? HEAD;
  const tree = treeAt(sequence);
  const record = {
    schemaVersion: "1",
    kind: "reused-proof-merge",
    repositoryId: "1315419165",
    baseRef: "refs/heads/main",
    queueEpoch: 1,
    transitionSequence: sequence,
    previousTransitionDigest: previous,
    before: { baseSha: before, treeOid: treeAt(sequence - 1) },
    after: {
      baseSha: after,
      treeOid: tree,
      parentOids: [before, head],
      parentCount: 2,
      parentOidsDigest: D("7"),
      parentsComplete: true,
    },
    observedAt: "2026-07-31T12:00:00Z",
    reusedProof: {
      attemptId: `att-${sequence}`,
      mergeIntentDigest: D("1"),
      pullRequestNumber: sequence,
      headSha: head,
      candidateSha: after,
      candidateTreeOid: tree,
      mergeMethod: "merge",
      workReceiptDigest: D("2"),
      policyDigest: D("6"),
      pipelineDigest: D("8"),
      requiredSuitesDigest: D("9"),
      checkRunId: "778899",
    },
    ...shape.over,
  };
  const bytes = canonicalBytes(JSON.stringify(record));
  return { digest: await envelopeDigest(bytes), bytes, jws: "signature" };
}

export async function link(
  sequence: number,
  previous: string | null,
  over: Record<string, unknown> = {},
): Promise<ChainLink> {
  return makeLink({ sequence, previous, over });
}

export const signedOk: ChainVerifierPorts = { verifySignature: async () => true, epochStartsAt: 1 };

/**
 * A chain whose links join up: link 2 begins exactly where link 1 ended.
 * Precomputed at module load, because the digest each link carries is a real
 * SHA-256 over its bytes and callers of `intactLinks()` need it synchronously.
 */
const INTACT: readonly ChainLink[] = await (async () => {
  const one = await link(1, null);
  const two = await link(2, one.digest);
  return [one, two];
})();

export function intactLinks(): ChainLink[] {
  return [...INTACT];
}

/**
 * The failure the sequence check cannot see, taken from the live chain: PR
 * 105 merged as `a1fe3e7` and wrote no record. Record 52 left the base at
 * `7059839`; record 53 says it began at `a1fe3e7`. Sequence numbers are
 * handed out per recorded transition, so the unrecorded merge leaves no hole
 * there — only the base moves, and that is what `BASE_DISCONTINUITY` catches.
 */
const GAP: readonly ChainLink[] = await (async () => {
  const fiftyTwoBefore = "797c695e4f7965b5592802a4e513fbd9e5982fa2";
  const fiftyTwoAfter = "7059839f29bf1aa0c0dd55e4e004cd64c155ba99";
  const unrecorded = "a1fe3e7e32aed7eaeefe799174d5c4962331ac40";
  const fiftyThreeAfter = "a5f50bacb82ee5fc16de2efc73d320c7deff30fe";
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
  return [fiftyTwo, fiftyThree];
})();

export function linksWithAGap(): ChainLink[] {
  return [...GAP];
}
