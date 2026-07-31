import { createLocalJWKSet, compactVerify, type JSONWebKeySet } from "jose";
import { verifyChain, type ChainFinding, type ChainLink } from "@thwip/queue-protocol";
import { flag } from "./cli-flags.js";
import { EXIT } from "./queue-exit.js";

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
    // How a record that has gone missing is told from history written before
    // records existed. Dropping it makes every gap look like the latter.
    sequence: l.sequence,
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

/**
 * A 4xx means the request itself is wrong (bad ref, unknown repository) and
 * retrying changes nothing; a 429 is a rate limit; a 5xx is the transient
 * class. See queue-exit.ts for the documented meaning of each.
 */
export function exitForStatus(status: number): number {
  if (status === 429) return EXIT.rateLimited;
  if (status >= 400 && status < 500) return EXIT.setupInvalid;
  return EXIT.unavailable;
}

/**
 * Resolve `owner/name` to a numeric GitHub repository id via GitHub's own
 * public API. No thwip session, no credentials: anyone can look up a public
 * repository id this way, which is what an outside auditor is.
 */
export async function resolveRepositoryIdFromGithub(repo: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "thwip-cli" },
  });
  if (!res.ok) return null;
  const { id } = (await res.json()) as { id: number };
  return String(id);
}

/**
 * Fetch a branch's chain and the keys thwip publishes, then verify it. The
 * chain and keys endpoints are deliberately public, so that a person with no
 * thwip account can check thwip's claims for themselves — that only works if
 * this command itself never needs to sign in. The id lookup goes through
 * GitHub's public API instead of thwip's own (authenticated) resolver, unlike
 * `thwip queue`, which mutates state and legitimately needs an identity.
 */
export async function cmdVerifyChain(argv: string[]): Promise<number> {
  const endpoint = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const repo = flag(argv, "--repo") ?? "";
  const repositoryIdFlag = flag(argv, "--repository-id");
  if (repositoryIdFlag === undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    process.stderr.write(
      "usage: thwip verify-chain --repo OWNER/NAME [--branch BRANCH]\n" +
        "       thwip verify-chain --repository-id ID [--branch BRANCH]\n",
    );
    return EXIT.usage;
  }
  const branch = flag(argv, "--branch") ?? "main";

  const repositoryId = repositoryIdFlag ?? (await resolveRepositoryIdFromGithub(repo));
  if (repositoryId === null) {
    process.stderr.write(`cannot resolve ${repo} (pass --repository-id to skip GitHub lookup)\n`);
    return EXIT.setupInvalid;
  }
  const ref = encodeURIComponent(`refs/heads/${branch}`);

  let chainRes: Response;
  let keysRes: Response;
  try {
    [chainRes, keysRes] = await Promise.all([
      fetch(`${endpoint}/v1/queue/${repositoryId}/chain?ref=${ref}`),
      fetch(`${endpoint}/.well-known/thwip-keys`),
    ]);
  } catch {
    process.stderr.write("could not reach thwip\n");
    return EXIT.unavailable;
  }
  if (!chainRes.ok) {
    process.stderr.write(`could not read the chain (${chainRes.status})\n`);
    return exitForStatus(chainRes.status);
  }
  const chain = (await chainRes.json()) as ChainResponse;
  const jwks = (await keysRes.json()) as JSONWebKeySet;

  const { verified, findings } = await verifyPublishedChain(chain, jwks);
  process.stdout.write(summarize(verified, findings) + "\n");
  return findings.some((f) => f.code !== "PRE_ATTESTATION") ? EXIT.evidenceRejected : EXIT.ok;
}
