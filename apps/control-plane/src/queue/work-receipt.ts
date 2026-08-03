import { b64stdDecode, extractCarrier, parseStatement, utf8Decode } from "@thwip/protocol";
import { envelopeDigest } from "@thwip/queue-protocol";
import type { Sha256 } from "@thwip/queue-protocol";

/**
 * The digest of the proof the developer actually signed.
 *
 * The merge walk bound `sha256:2222…2222` for this — a constant, not a digest of
 * anything — so everything downstream that cited a work receipt was citing a
 * placeholder, and the chain's claim to record what was checked before a merge
 * landed had nothing behind it.
 *
 * The evidence was never missing. The proof rides on the head commit and the
 * required check already verifies it; it simply was not carried through to the
 * merge.
 *
 * The digest is taken over the carrier exactly as the commit holds it. Re-encoding
 * first would produce a digest of something that merely means the same thing,
 * and a digest is only worth having if it names the bytes somebody signed.
 */
export async function workReceiptDigestFrom(commitMessage: string): Promise<Sha256 | null> {
  const carrier = extractCarrier(commitMessage);
  // No proof, an unreadable one, or two of them. Each is a reason to have no
  // work receipt rather than to invent one — a placeholder here is exactly how
  // an empty claim gets signed into a record that looks like evidence.
  if (!carrier.ok) return null;
  return envelopeDigest(carrier.envelopeRawBytes);
}

/** What the proof on the head committed itself to. */
export interface ProofBinding {
  readonly policyDigest: string;
  readonly pipelineDigest: string;
  /** Suite ids the proof reports as passed, in the order it reported them. */
  readonly passedSuites: readonly string[];
}

/**
 * The policy the head's proof bound, read from the proof.
 *
 * A reuse merge signs a policy digest, a pipeline digest and a required-suites
 * digest as the equivalence it rests on, and it took all three from the
 * repository's current policy. Nothing read the proof's own. A repository could
 * add a required suite and still merge a proof that never ran it, under a record
 * asserting it had.
 *
 * Read from the commit rather than from a stored verification row: the row says
 * what was active when the App judged the proof, and the question here is what
 * the developer actually signed.
 *
 * Null for a commit with no readable proof, or one whose payload is not a thwip
 * predicate. Both leave the merge with nothing to compare against, which is a
 * refusal.
 */
/** What a proof can fail, read off the policy in force. */
export interface PolicyRequirements {
  /** Null when the policy names no pipeline, which is nothing to compare against. */
  readonly pipelineDigest: string | null;
  readonly requiredSuites: readonly string[];
}

/**
 * What the head's proof does not cover of the policy in force, or null when it
 * covers all of it.
 *
 * Requirements, never identity. A policy's digest changes when anything in it
 * changes, including settings a proof cannot fail: the minimum permission, the
 * allowed key algorithms, the lease rules, the proof's maximum age. Refusing on
 * the digest made a cosmetic edit invalidate every proof in flight, and the App
 * carried a twenty-four hour list of retired digests to hide that. The list is
 * gone. What a proof can fail is the pipeline it ran and the suites it passed.
 *
 * The same two comparisons `reuseEvidenceFor` makes, in the same order, because
 * readiness and the merge gate reaching different verdicts about one head is
 * the whole class of bug this exists to close. The merge gate refuses on them
 * after the pull request has spent its turn; this is the same answer before the
 * offer goes out.
 *
 * Null for a proof that cannot be read and for a policy with no pipeline.
 * Neither is a disagreement, and `LOCAL_RECEIPT_MISSING` already covers a head
 * with no proof on it.
 */
export function proofShortfall(proof: ProofBinding | null, policy: PolicyRequirements | null): string | null {
  if (proof === null || policy === null || policy.pipelineDigest === null) return null;
  if (proof.pipelineDigest !== policy.pipelineDigest) {
    return `the head's proof ran pipeline ${proof.pipelineDigest} and ${policy.pipelineDigest} is in force`;
  }
  // Named as suites and not only as a digest, because a proof that skipped a
  // required suite is the thing a developer has to be told about by name.
  const unproven = policy.requiredSuites.filter((suite) => !proof.passedSuites.includes(suite));
  return unproven.length > 0 ? `the head's proof did not pass ${unproven.join(", ")}` : null;
}

export function proofBindingFrom(commitMessage: string): ProofBinding | null {
  const carrier = extractCarrier(commitMessage);
  if (!carrier.ok) return null;
  let statement: unknown;
  try {
    statement = JSON.parse(utf8Decode(b64stdDecode(carrier.envelope.payload)));
  } catch {
    return null;
  }
  const parsed = parseStatement(statement);
  if (!parsed.ok) return null;
  const predicate = parsed.value.predicate;
  return {
    policyDigest: predicate.policy.digest,
    pipelineDigest: predicate.pipeline.digest,
    passedSuites: predicate.run.suites.filter((suite) => suite.status === "passed").map((suite) => suite.id),
  };
}
