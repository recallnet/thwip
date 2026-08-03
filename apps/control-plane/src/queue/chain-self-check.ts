import { verifyChain, type ChainFinding, type ChainLink, type ChainVerifierPorts } from "@thwip/queue-protocol";

/**
 * Reading the queue's own chain the way an outsider would.
 *
 * `verifyChain` has reported `BASE_DISCONTINUITY` since the day a missing merge
 * was first understood, and nothing ran it. Four merges were missing from this
 * repository's chain for a day before anybody looked, and they were found by a
 * script written for a blog post. A check nobody runs is a check that does not
 * exist.
 *
 * `NOTHING_CHECKED` is this module's own finding rather than the verifier's. An
 * `epochStartsAt` past the end of the chain makes every link skip its signature
 * and produces no finding at all, so a caller reading only `findings.length`
 * would call that chain clean having verified nothing.
 */
export type SelfCheckFinding = ChainFinding | { code: "NOTHING_CHECKED"; sequence: null; digest: ""; detail: string };

export async function checkOwnChain(
  links: readonly ChainLink[],
  ports: ChainVerifierPorts,
): Promise<SelfCheckFinding[]> {
  const result = await verifyChain(links, ports);
  const findings: SelfCheckFinding[] = [...result.findings];
  if (links.length > 0 && result.signaturesChecked === 0) {
    findings.push({
      code: "NOTHING_CHECKED",
      sequence: null,
      digest: "",
      detail: `the walk read ${links.length} link(s) and verified no signature`,
    });
  }
  return findings;
}
