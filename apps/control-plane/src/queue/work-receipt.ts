import { extractCarrier } from "@thwip/protocol";
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
