import { appendFileSync } from "node:fs";
import { createLocalJWKSet, compactVerify, type JSONWebKeySet } from "jose";
import {
  parseTransitionRecord,
  verifyChain,
  type ChainCorrection,
  type ChainFinding,
  type ChainLink,
  type TransitionRecordV1,
} from "@thwip/queue-protocol";
import { flag } from "./cli-flags.js";
import { DEFAULT_ENDPOINT } from "./endpoint.js";
import { EXIT } from "./queue-exit.js";

/**
 * Check a branch's chain against the keys thwip publishes.
 *
 * Everything is fetched: the links, and the keys that signed them. Nothing is
 * taken on trust except that the digest in a link names the bytes beside it,
 * which is the one thing this checks first.
 */

/**
 * What was established, said in the summary's first line.
 *
 * `totalLinks` and `signaturesChecked` are reported together on purpose. A
 * link with no bytes to read (`PRE_ATTESTATION`, `MISSING_RECORD`) or bytes
 * that do not parse (`UNPARSEABLE`) was never going to have a signature
 * checked, and that is not a problem — but every other readable link is
 * expected to, and `epochStartsAt` can silently make it skip that check
 * without raising a finding.
 *
 * Subtracting the unreadable links from the expected count used to let a
 * response of nothing but history land on "0 of 0 checked", which read as
 * agreement and printed the clean line. So the count is not the whole test:
 * a run that checked no signature at all never reaches the clean line,
 * whatever the arithmetic says, because verifying nothing is not verifying.
 * An earlier attempt at this changed only the wording and left both the
 * arithmetic and the exit code alone.
 */
export function summarize(
  totalLinks: number,
  signaturesChecked: number,
  findings: readonly ChainFinding[],
  corrections: readonly ChainCorrection[] = [],
): string {
  const history = findings.filter((f) => f.code === "PRE_ATTESTATION");
  const unreadable = findings.filter((f) => f.code === "UNPARSEABLE" || f.code === "MISSING_RECORD").length;
  const expectedChecks = totalLinks - history.length - unreadable;
  const problems = findings.filter((f) => f.code !== "PRE_ATTESTATION");

  const lines: string[] = [];
  if (signaturesChecked === 0) {
    // Counted against every link, not against the ones that were expected to
    // carry a signature. When the expectation itself is zero, "0 of 0" is the
    // sentence that started this.
    lines.push(`${totalLinks} links, 0 of ${totalLinks} signatures checked: nothing was verified.`);
  } else if (problems.length === 0 && signaturesChecked === expectedChecks) {
    lines.push(`${totalLinks} links verified (${signaturesChecked} signatures checked).`);
  } else if (problems.length === 0) {
    lines.push(
      `${totalLinks} links, ${signaturesChecked} of ${expectedChecks} signatures checked: not a clean verification.`,
    );
  } else {
    lines.push(
      `${problems.length} problem${problems.length === 1 ? "" : "s"} in ${totalLinks} links ` +
        `(${signaturesChecked} of ${expectedChecks} signatures checked).`,
    );
  }
  if (history.length > 0) {
    lines.push(`${history.length} link${history.length === 1 ? "" : "s"} predates signed records.`);
  }
  // Printed on a clean run as well as a dirty one. A chain that verifies
  // because a record was corrected is not the same as a chain that never got
  // anything wrong, and a reader who is not told cannot tell them apart.
  if (corrections.length > 0) {
    lines.push(`${corrections.length} record${corrections.length === 1 ? " was" : "s were"} corrected.`);
    for (const k of corrections) {
      lines.push(
        `  link ${k.sequence} corrects link ${k.correctsSequence}: the base became ${k.to}, not ${k.from} ` +
          `(${k.actorPrincipalId}, ${k.observedAt}): ${k.reason}`,
      );
    }
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
 * Whether a parsed JWK carries the members its `kty` needs to actually
 * verify anything. `compactVerify` will happily accept a key object that is
 * missing `crv`/`x`/`y` (or the RSA/OKP equivalents) at construction time
 * and only fail once asked to verify — at which point the catch in
 * `verifySignature` cannot tell "this key is junk" from "this signature is
 * forged", and every link ends up reported `BAD_SIGNATURE`.
 */
function isUsableKey(key: unknown): boolean {
  if (typeof key !== "object" || key === null) return false;
  const k = key as Record<string, unknown>;
  const has = (fields: readonly string[]) => fields.every((f) => typeof k[f] === "string" && k[f] !== "");
  switch (k["kty"]) {
    case "EC":
      return has(["crv", "x", "y"]);
    case "RSA":
      return has(["n", "e"]);
    case "OKP":
      return has(["crv", "x"]);
    default:
      return false;
  }
}

/**
 * Non-empty, shaped like a key set, and containing at least one key that
 * could plausibly verify a signature. A 200 with no keys — a fresh isolate
 * that has not signed yet, or an empty table — must not be treated as "we
 * checked every signature and none of them verified": there was nothing to
 * check against, which is a different fact and belongs to a different
 * verdict. A 200 whose keys are present but unusable (missing the members
 * their own `kty` requires) is the same fact one step narrower, and is
 * rejected here rather than left to surface as `BAD_SIGNATURE` on every link.
 */
export function parseKeySet(body: unknown): JSONWebKeySet | null {
  if (typeof body !== "object" || body === null) return null;
  const keys = (body as Record<string, unknown>)["keys"];
  if (!Array.isArray(keys) || keys.length === 0) return null;
  if (!keys.some(isUsableKey)) return null;
  return body as JSONWebKeySet;
}

export async function verifyPublishedChain(
  chain: ChainResponse,
  jwks: JSONWebKeySet,
  subject?: { readonly repositoryId: string; readonly baseRef: string },
  epochStartsAt?: number,
  head?: { readonly baseSha: string },
): Promise<{
  totalLinks: number;
  signaturesChecked: number;
  findings: readonly ChainFinding[];
  corrections: readonly ChainCorrection[];
}> {
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

  const { findings, signaturesChecked, corrections } = await verifyChain(links, {
    // Pinned when the caller says so; otherwise whatever the server claims.
    // The server's claim is not trusted to be safe to use unpinned — a
    // caller that cares pins it — but an unpinned run still has to use
    // something, and reporting it (see cmdVerifyChain) is what keeps a
    // silent shift from passing unnoticed.
    epochStartsAt: epochStartsAt ?? chain.epochStartsAt,
    ...(subject === undefined ? {} : { subject }),
    ...(head === undefined ? {} : { head }),
    async verifySignature(jws, bytes) {
      try {
        const { payload } = await compactVerify(jws, keys);
        return new TextDecoder().decode(payload) === new TextDecoder().decode(bytes);
      } catch {
        return false;
      }
    },
  });
  return { totalLinks: links.length, signaturesChecked, findings, corrections };
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
 * Where the branch actually stands, asked of GitHub rather than of thwip.
 *
 * Merges that landed after the last record leave nothing inside the chain to
 * compare against, so the chain cannot report itself behind. Asking the service
 * for the head it is behind would answer that with the head it recorded, which
 * is no answer. GitHub serves this for any public repository with no
 * credentials, which is exactly the position an outside auditor is in.
 */
async function resolveBranchHeadFromGithub(repo: string, branch: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "thwip-cli" },
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { commit?: { sha?: unknown } } | null;
  const sha = body?.commit?.sha;
  return typeof sha === "string" && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

export interface PublishedRecord {
  readonly digest: string;
  readonly sequence: number;
  readonly record: TransitionRecordV1;
}

function recordsFromChain(chain: ChainResponse): PublishedRecord[] {
  const records: PublishedRecord[] = [];
  for (const link of chain.links) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(link.record);
    } catch {
      continue;
    }
    const parsed = parseTransitionRecord(decoded);
    if (parsed.ok) records.push({ digest: link.digest, sequence: link.sequence, record: parsed.value });
  }
  return records;
}

/** Require one signed, non-override merge record for the exact deploy SHA. */
export function evaluateDeployEvidence(
  report: {
    readonly findings: readonly ChainFinding[];
    readonly signaturesChecked: number;
    readonly records: readonly PublishedRecord[];
    readonly epochStartsAt: number;
  },
  expectedSha: string,
): { readonly ok: false; readonly reason: string } | {
  readonly ok: true;
  readonly evidence: {
    readonly digest: string;
    readonly sequence: number;
    readonly kind: string;
    readonly pullRequestNumber: number;
    readonly sha: string;
  };
} {
  const problems = report.findings.filter((finding) => finding.code !== "PRE_ATTESTATION");
  if (problems.length > 0) {
    return { ok: false, reason: problems.map((finding) => `${finding.code}: ${finding.detail}`).join("; ") };
  }
  if (report.signaturesChecked === 0) return { ok: false, reason: "no signatures were verified" };
  const matches = report.records.filter(({ record }) => record.after.baseSha === expectedSha);
  if (matches.length !== 1) {
    return { ok: false, reason: `the published chain has ${matches.length} records for ${expectedSha}` };
  }
  const match = matches[0]!;
  if (!Number.isSafeInteger(match.sequence) || match.sequence < report.epochStartsAt) {
    return { ok: false, reason: `record ${match.sequence} is outside the signed range` };
  }
  if (
    match.record.kind !== "verified-merge" &&
    match.record.kind !== "reused-proof-merge" &&
    match.record.kind !== "candidate-verified-merge"
  ) {
    return { ok: false, reason: `record ${match.sequence} is ${match.record.kind}, not a verified merge` };
  }
  const facts = match.record.kind === "verified-merge"
    ? match.record.verifiedMerge
    : match.record.kind === "reused-proof-merge"
      ? match.record.reusedProof
      : match.record.candidateVerified;
  return {
    ok: true,
    evidence: {
      digest: match.digest,
      sequence: match.sequence,
      kind: match.record.kind,
      pullRequestNumber: facts.pullRequestNumber,
      sha: expectedSha,
    },
  };
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
  const endpoint = process.env["THWIP_ENDPOINT"] ?? DEFAULT_ENDPOINT;
  const repo = flag(argv, "--repo") ?? "";
  const repositoryIdFlag = flag(argv, "--repository-id");
  if (repositoryIdFlag === undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    process.stderr.write(
      "usage: thwip verify-chain --repo OWNER/NAME [--branch BRANCH]\n" +
        "       thwip verify-chain --repository-id ID [--branch BRANCH] [--expected-sha SHA]\n",
    );
    return EXIT.usage;
  }
  const branch = flag(argv, "--branch") ?? "main";
  const baseRef = `refs/heads/${branch}`;
  const expectedSha = flag(argv, "--expected-sha");
  if (expectedSha !== undefined && !/^[0-9a-f]{40,64}$/.test(expectedSha)) {
    process.stderr.write("--expected-sha must be a full Git object id\n");
    return EXIT.usage;
  }

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
    process.stderr.write("thwip's published signing keys could not be used; the chain was not checked\n");
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

  // Only when the repository was named as owner/name: a run given a bare
  // --repository-id has nothing to ask GitHub about. Printed either way, so a
  // run that could not compare the head does not read as one that did.
  const head = expectedSha ?? (
    /^[\w.-]+\/[\w.-]+$/.test(repo)
      ? await resolveBranchHeadFromGithub(repo, branch).catch(() => null)
      : null
  );
  process.stdout.write(
    head === null
      ? "head: not checked; a merge landing after the last record would not be visible\n"
      : `head: ${head} (${expectedSha === undefined ? "from github" : "expected"})\n`,
  );

  const { totalLinks, signaturesChecked, findings, corrections } = await verifyPublishedChain(
    chain,
    jwks,
    { repositoryId, baseRef },
    epochStartsAt,
    head === null ? undefined : { baseSha: head },
  );
  process.stdout.write(summarize(totalLinks, signaturesChecked, findings, corrections) + "\n");
  if (findings.some((f) => f.code !== "PRE_ATTESTATION")) return EXIT.evidenceRejected;
  // Nothing checked is not a pass. A gate scripted on this exit status is the
  // whole point of the command, and it used to succeed on a run that verified
  // no signature at all: a server claiming its epoch starts far in the future
  // made every check skip, no finding fired, and the chain could be entirely
  // fabricated. A verifier that returns success having checked nothing is
  // worse than no verifier, because the gate that trusts it now passes forged
  // evidence. A branch with no merges lands here too, and that is right —
  // "nothing has merged" and "every merge was withheld" look identical from
  // out here, and neither one is a verification.
  if (signaturesChecked === 0) return EXIT.evidenceRejected;
  if (expectedSha !== undefined) {
    const decision = evaluateDeployEvidence({
      findings,
      signaturesChecked,
      records: recordsFromChain(chain),
      epochStartsAt,
    }, expectedSha);
    if (!decision.ok) {
      process.stderr.write(`deploy evidence refused: ${decision.reason}\n`);
      return EXIT.evidenceRejected;
    }
    const evidence = decision.evidence;
    process.stdout.write(
      `verified deploy evidence: record ${evidence.sequence} (${evidence.kind}) binds PR #${evidence.pullRequestNumber} to ${evidence.sha}\n`,
    );
    if (process.env["GITHUB_OUTPUT"]) {
      appendFileSync(process.env["GITHUB_OUTPUT"], [
        `record_digest=${evidence.digest}`,
        `record_sequence=${evidence.sequence}`,
        `merge_kind=${evidence.kind}`,
        `pull_request=${evidence.pullRequestNumber}`,
        `verified_sha=${evidence.sha}`,
      ].join("\n") + "\n");
    }
  }
  return EXIT.ok;
}
