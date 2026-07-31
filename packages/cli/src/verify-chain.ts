import { createLocalJWKSet, compactVerify, type JSONWebKeySet } from "jose";
import { verifyChain, type ChainFinding, type ChainLink } from "@thwip/queue-protocol";

/**
 * Check a branch's chain against the keys thwip publishes.
 *
 * Everything is fetched: the links, and the keys that signed them. Nothing is
 * taken on trust except that the digest in a link names the bytes beside it,
 * which is the one thing this checks first.
 */

export function summarize(verified: number, findings: readonly ChainFinding[]): string {
  const history = findings.filter((f) => f.code === "PRE_ATTESTATION");
  const problems = findings.filter((f) => f.code !== "PRE_ATTESTATION");

  const lines: string[] = [];
  if (problems.length === 0) {
    lines.push(`${verified} links verified.`);
  } else {
    lines.push(`${problems.length} problem${problems.length === 1 ? "" : "s"} in ${verified} links.`);
  }
  if (history.length > 0) {
    lines.push(`${history.length} link${history.length === 1 ? "" : "s"} predates signed records.`);
  }
  for (const p of problems) {
    const where = p.sequence === null ? p.digest.slice(0, 16) : `link ${p.sequence}`;
    lines.push(`  ${p.code} at ${where}: ${p.detail}`);
  }
  return lines.join("\n");
}

export interface ChainResponse {
  readonly epochStartsAt: number;
  readonly links: ReadonlyArray<{ digest: string; sequence: number; record: string; jws: string }>;
}

export async function verifyPublishedChain(
  chain: ChainResponse,
  jwks: JSONWebKeySet,
): Promise<{ verified: number; findings: readonly ChainFinding[] }> {
  const keys = createLocalJWKSet(jwks);
  const encoder = new TextEncoder();
  const links: ChainLink[] = chain.links.map((l) => ({
    digest: l.digest,
    bytes: encoder.encode(l.record),
    jws: l.jws,
  }));

  const findings = await verifyChain(links, {
    epochStartsAt: chain.epochStartsAt,
    async verifySignature(jws, bytes) {
      try {
        const { payload } = await compactVerify(jws, keys);
        return new TextDecoder().decode(payload) === new TextDecoder().decode(bytes);
      } catch {
        return false;
      }
    },
  });
  return { verified: links.length, findings };
}
