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

/**
 * Check the shape before any of it is trusted.
 *
 * The response comes straight off the network: a malformed body, an error page
 * that happened to return 200, or a future version this build does not know
 * would otherwise be cast to `ChainResponse` and crash the first time
 * `.links.map` ran against something that is not an array. A shape that does
 * not hold is reported like any other unreachable chain, not a stack trace.
 */
export function parseChainResponse(body: unknown): ChainResponse | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b["epochStartsAt"] !== "number") return null;
  if (!Array.isArray(b["links"])) return null;
  for (const l of b["links"]) {
    if (typeof l !== "object" || l === null) return null;
    const ll = l as Record<string, unknown>;
    if (
      typeof ll["digest"] !== "string" ||
      typeof ll["record"] !== "string" ||
      typeof ll["jws"] !== "string" ||
      typeof ll["sequence"] !== "number"
    ) {
      return null;
    }
  }
  return { epochStartsAt: b["epochStartsAt"], links: b["links"] as ChainResponse["links"] };
}

/**
 * Non-empty and shaped like a key set. A 200 with no keys — a fresh isolate
 * that has not signed yet, or an empty table — must not be treated as "we
 * checked every signature and none of them verified": there was nothing to
 * check against, which is a different fact and belongs to a different verdict.
 */
export function parseKeySet(body: unknown): JSONWebKeySet | null {
  if (typeof body !== "object" || body === null) return null;
  const keys = (body as Record<string, unknown>)["keys"];
  if (!Array.isArray(keys) || keys.length === 0) return null;
  return body as JSONWebKeySet;
}

export async function verifyPublishedChain(
  chain: ChainResponse,
  jwks: JSONWebKeySet,
  subject?: { readonly repositoryId: string; readonly baseRef: string },
  epochStartsAt?: number,
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
    // Pinned when the caller says so; otherwise whatever the server claims.
    // The server's claim is not trusted to be safe to use unpinned — a
    // caller that cares pins it — but an unpinned run still has to use
    // something, and reporting it (see cmdVerifyChain) is what keeps a
    // silent shift from passing unnoticed.
    epochStartsAt: epochStartsAt ?? chain.epochStartsAt,
    ...(subject === undefined ? {} : { subject }),
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
  const baseRef = `refs/heads/${branch}`;

  // Pins the epoch a caller does not trust the server to report honestly. The
  // server's own claim decides where signature checking starts, and a server
  // returning a huge value would make the verifier skip every signature while
  // raising no finding. Pinning is the only way to catch that from outside.
  const epochFlag = flag(argv, "--epoch");
  let pinnedEpoch: number | undefined;
  if (epochFlag !== undefined) {
    const parsed = Number(epochFlag);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      process.stderr.write("--epoch must be a non-negative integer\n");
      return EXIT.usage;
    }
    pinnedEpoch = parsed;
  }

  const repositoryId = repositoryIdFlag ?? (await resolveRepositoryIdFromGithub(repo));
  if (repositoryId === null) {
    process.stderr.write(`cannot resolve ${repo} (pass --repository-id to skip GitHub lookup)\n`);
    return EXIT.setupInvalid;
  }
  const ref = encodeURIComponent(baseRef);

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

  // A keys fetch that fails, or a key set that is empty, means nothing can be
  // checked — not that nothing checked out. Every signature would fail against
  // no keys at all, which is indistinguishable from a service that forged its
  // whole chain unless this is caught first. Accusing the service of forgery
  // because a fetch failed is the worst verdict this command can give, so it
  // never reaches the point of emitting one.
  if (!keysRes.ok) {
    process.stderr.write(`could not fetch thwip's signing keys (${keysRes.status}); the chain was not checked\n`);
    return EXIT.unavailable;
  }
  const jwks = parseKeySet(await keysRes.json().catch(() => null));
  if (jwks === null) {
    process.stderr.write("thwip published no signing keys; the chain was not checked\n");
    return EXIT.unavailable;
  }

  const chain = parseChainResponse(await chainRes.json().catch(() => null));
  if (chain === null) {
    process.stderr.write("the chain response could not be read\n");
    return EXIT.unavailable;
  }

  const epochStartsAt = pinnedEpoch ?? chain.epochStartsAt;
  // Printed unconditionally, pinned or not: a silent shift in what got
  // checked must be visible, not just resistant to being missed.
  process.stdout.write(`epoch: ${epochStartsAt}${pinnedEpoch !== undefined ? " (pinned)" : ""}\n`);

  const { verified, findings } = await verifyPublishedChain(
    chain,
    jwks,
    { repositoryId, baseRef },
    epochStartsAt,
  );
  process.stdout.write(summarize(verified, findings) + "\n");
  return findings.some((f) => f.code !== "PRE_ATTESTATION") ? EXIT.evidenceRejected : EXIT.ok;
}
