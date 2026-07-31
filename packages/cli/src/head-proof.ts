import { extractCarrier, parseStatement, b64stdDecode, utf8Decode } from "@thwip/protocol";

/**
 * What HEAD's proof says about HEAD's tree.
 *
 * A proof binds one exact tree, and it travels in the commit message. A rebase
 * rewrites the commit but keeps the message, so the proof survives while the
 * tree it describes does not. Nothing about the trailer being present says
 * whether it still describes this commit.
 *
 * `ship` used to decide from presence alone: it saw a trailer, concluded there
 * was nothing to sign, and pushed. The required check then rejected the commit
 * with SUBJECT_TREE_MISMATCH, which costs a full trip through CI to discover and
 * says nothing about how to fix it. Comparing the trees here is the whole fix.
 *
 * `stale` and `missing` are both repaired by signing again. They stay separate
 * because they are different situations to be in — one is a rebase, the other is
 * a commit that was never signed — and the person reading the output is the one
 * who has to know which.
 */
export type HeadProofState = "accepted" | "missing" | "stale";

export function headProofState(commitMessage: string, headTreeOid: string): HeadProofState {
  const carrier = extractCarrier(commitMessage);
  if (!carrier.ok) return "missing";

  let statement: unknown;
  try {
    statement = JSON.parse(utf8Decode(b64stdDecode(carrier.envelope.payload)));
  } catch {
    // Unreadable is not the same as absent, but it is repaired the same way and
    // there is nothing here to compare a tree against.
    return "missing";
  }

  const parsed = parseStatement(statement);
  if (!parsed.ok) return "missing";

  const digest = parsed.value.subject[0]?.digest;
  const signedTree = digest?.["sha1"] ?? digest?.["sha256"];
  if (signedTree === undefined) return "missing";

  return signedTree === headTreeOid ? "accepted" : "stale";
}
