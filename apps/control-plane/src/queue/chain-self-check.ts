import { compactVerify, createLocalJWKSet, type JSONWebKeySet } from "jose";
import { verifyChain, type ChainFinding, type ChainLink, type ChainVerifierPorts } from "@thwip/queue-protocol";
import { readChain } from "./attestation.js";
import { verificationKeys } from "../service-keys.js";
import type { D1Like } from "./projection.js";

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

/**
 * Read one branch's chain out of D1 and check it, with the keys the service
 * publishes.
 *
 * One producer, so the heartbeat and the project page cannot disagree about
 * whether a chain is whole. An administrator acting on a finding has to be
 * acting on the same finding the tick reported, and two call sites assembling
 * the verifier by hand is how that stops being true.
 *
 * The key set is read here, per call, rather than handed in. A record signed
 * moments ago under a kid this isolate has only just published would be checked
 * against a key set taken before that insert and reported as `BAD_SIGNATURE`:
 * a false alarm on the exact signal this exists to make trustworthy, and one
 * that clears itself on the next read, which makes it rarer and harder to
 * diagnose rather than less bad.
 */
export async function findingsForChain(
  db: D1Like,
  input: { readonly repositoryId: string; readonly baseRef: string; readonly epochStartsAt: number },
): Promise<SelfCheckFinding[]> {
  const published: JSONWebKeySet = { keys: await verificationKeys(db) };
  const keySet = createLocalJWKSet(published);
  const links = await readChain(db, input.repositoryId, input.baseRef);
  return checkOwnChain(links, {
    epochStartsAt: input.epochStartsAt,
    subject: { repositoryId: input.repositoryId, baseRef: input.baseRef },
    async verifySignature(jws, bytes) {
      try {
        const { payload } = await compactVerify(jws, keySet);
        return new TextDecoder().decode(payload) === new TextDecoder().decode(bytes);
      } catch {
        return false;
      }
    },
  });
}
