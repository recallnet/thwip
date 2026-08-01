import {
  DSSE_PAYLOAD_TYPE,
  SSH_SIGN_NAMESPACE,
  b64stdDecode,
  dssePae,
  extractCarrier,
  parseStatement,
  utf8Decode,
  utf8Encode,
  type EnrolledKey,
  type InTotoStatementV1,
  type ReasonCode,
  type VerificationBundleV1,
} from "@thwip/protocol";
import { settleRemoteSuites } from "./remote-suite-settlement.js";

/** Facts the Action derives independently from GitHub. Never taken from the proof. */
export interface GithubFacts {
  ownerId: string;
  repositoryId: string;
  headSha: string;
  treeOid: string;
  parentOids: string[];
  baseRef: string;
  baseSha: string;
  objectFormat: "sha1" | "sha256";
  /** numeric GitHub user id of the PR author, when known */
  prAuthorGithubUserId?: string;
  /**
   * Tree of GitHub's own merge of this head into the base, read from the
   * provider. Required when the policy evaluates merge trees; the verifier
   * refuses that mode rather than guess when the caller cannot supply it.
   */
  mergeTreeOid?: string;
  /** Paths this head changes against the base, when the caller can list them. */
  changedPaths?: string[];
}

export interface VerifyDeps {
  /**
   * Conclusions of checks GitHub itself ran on this commit, by check name.
   * Suites a project marks `remote` are proven by GitHub rather than by the
   * signer, so the merge gate is one decision over two evidence sources.
   */
  remoteCheckConclusions?: (headSha: string) => Promise<Map<string, string>>;
  /**
   * Verify an OpenSSH SSHSIG signature (standard base64 of the binary SSHSIG
   * blob) over `message` under `namespace` with an authorized_keys-format
   * public key. Injected so the verifier itself stays pure.
   */
  verifySshSignature(args: {
    publicKey: string;
    namespace: string;
    message: Uint8Array;
    signatureBase64: string;
  }): Promise<boolean>;
  /**
   * Verify one compact-JWS signing input against one JWK from
   * `bundle.leaseIssuerJwks`. The verifier parses the lease, chooses the
   * candidate keys and judges every claim itself; this only does the maths.
   * A policy that requires a lease refuses when this is missing.
   */
  verifyLeaseSignature?(args: {
    jwk: unknown;
    algorithm: string;
    signingInput: Uint8Array;
    signature: Uint8Array;
  }): Promise<boolean>;
  /**
   * SSH public keys GitHub currently publishes for a user, in
   * authorized_keys format. A policy with `requireGithubKeyPresence` refuses
   * when this is missing.
   */
  githubUserSigningKeys?(githubUserId: string): Promise<string[]>;
  /**
   * An independent re-run of the proven pipeline over the same tree. A policy
   * that selects this proof for audit refuses when this is missing.
   */
  auditProof?(args: {
    statement: InTotoStatementV1;
    facts: GithubFacts;
  }): Promise<{ agrees: boolean; detail?: string }>;
  /**
   * Waiting between reads of a source that is eventually consistent with its
   * own writes. Injected so tests read as many times as production does without
   * spending the backoff.
   */
  sleep?(ms: number): Promise<void>;
}

export interface VerifyResult {
  code: ReasonCode;
  detail?: string;
  statement?: InTotoStatementV1;
  signerKey?: EnrolledKey;
}

export interface VerifyInput {
  commitMessage: string;
  facts: GithubFacts;
  bundle: VerificationBundleV1;
  /** injected clock, ISO-8601 */
  now: string;
}

const PERMISSION_RANK: Record<string, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

function res(code: ReasonCode, detail?: string, extra?: Partial<VerifyResult>): VerifyResult {
  return { code, ...(detail !== undefined ? { detail } : {}), ...extra };
}

export async function verifyProof(input: VerifyInput, deps: VerifyDeps): Promise<VerifyResult> {
  const { facts, bundle } = input;
  const nowMs = Date.parse(input.now);
  // An unreadable clock makes every window comparison below false, which would
  // read as "nothing expired". Refuse instead.
  if (!Number.isFinite(nowMs)) {
    return res("BUNDLE_UNAVAILABLE", "the verifier was given a clock reading it cannot parse; pass an ISO-8601 timestamp as `now`");
  }

  // Bundle freshness (authenticity is established by the adapter's JWS check).
  const bundleExpiry = Date.parse(bundle.expiresAt);
  if (!Number.isFinite(bundleExpiry)) {
    return res("BUNDLE_UNAVAILABLE", "the bundle carries an expiry this verifier cannot read, so its freshness cannot be judged");
  }
  if (bundleExpiry < nowMs) return res("BUNDLE_EXPIRED");

  // 1. Carrier extraction and envelope shape.
  const carrier = extractCarrier(input.commitMessage);
  if (!carrier.ok) {
    const e = carrier.error;
    return res(e.code, "detail" in e ? e.detail : undefined);
  }
  const envelope = carrier.envelope;

  // 2. Signature over exact decoded payload bytes, before parsing content.
  let payloadBytes: Uint8Array;
  try {
    payloadBytes = b64stdDecode(envelope.payload);
  } catch {
    return res("PROOF_MALFORMED", "payload not base64");
  }
  const keyid = envelope.signatures[0]!.keyid;
  const key = bundle.keys.find((k) => k.keyId === keyid);
  if (!key) return res("SIGNER_KEY_UNKNOWN", keyid);
  if (key.revokedAt !== null) return res("SIGNER_KEY_REVOKED", keyid);
  if (!bundle.policy.allowedKeyAlgorithms.includes(key.algorithm)) {
    return res("SIGNER_KEY_ALGORITHM_FORBIDDEN", key.algorithm);
  }
  const pae = dssePae(DSSE_PAYLOAD_TYPE, payloadBytes);
  let sigOk: boolean;
  try {
    sigOk = await deps.verifySshSignature({
      publicKey: key.publicKey,
      namespace: SSH_SIGN_NAMESPACE,
      message: pae,
      signatureBase64: envelope.signatures[0]!.sig,
    });
  } catch {
    sigOk = false;
  }
  if (!sigOk) return res("SIGNATURE_INVALID");

  // 3. Parse the signed statement strictly.
  let statementJson: unknown;
  try {
    statementJson = JSON.parse(utf8Decode(payloadBytes));
  } catch {
    return res("PROOF_MALFORMED", "payload not JSON");
  }
  const parsed = parseStatement(statementJson);
  if (!parsed.ok) return res("PROOF_MALFORMED", parsed.detail);
  const statement = parsed.value;
  const pred = statement.predicate;

  // 4. Subject: repository identity from GitHub, never from the proof.
  if (pred.repository.ownerId !== facts.ownerId || pred.repository.repositoryId !== facts.repositoryId) {
    return res("SUBJECT_REPOSITORY_MISMATCH", undefined, { statement });
  }
  if (
    bundle.repositoryId !== facts.repositoryId ||
    bundle.ownerId !== facts.ownerId
  ) {
    return res("SUBJECT_REPOSITORY_MISMATCH", "bundle/facts repository disagreement", { statement });
  }

  // 5. Exact Git subject.
  if (pred.git.objectFormat !== facts.objectFormat) return res("SUBJECT_TREE_MISMATCH", "object format", { statement });
  const subjectDigest = statement.subject[0]!.digest[facts.objectFormat];
  if (subjectDigest !== facts.treeOid || pred.git.treeOid !== facts.treeOid) {
    return res("SUBJECT_TREE_MISMATCH", undefined, { statement });
  }
  const declaredParents = pred.git.parentOids;
  if (
    declaredParents.length !== facts.parentOids.length ||
    declaredParents.some((p, i) => p !== facts.parentOids[i])
  ) {
    return res("SUBJECT_ANCESTRY_MISMATCH", undefined, { statement });
  }
  if (pred.git.baseSha !== facts.baseSha) return res("SUBJECT_BASE_MISMATCH", undefined, { statement });

  // 5b. Merge tree. Under `merge-tree` the claim is about the tree the merge
  // produces, so the proof has to name it and it has to be the tree GitHub gets
  // when it merges this head into the base.
  if (bundle.policy.evaluationMode === "merge-tree") {
    const claimed = pred.git.mergeTreeOid;
    if (claimed === undefined) {
      return res(
        "SUBJECT_TREE_MISMATCH",
        "this project verifies the merged tree and the proof does not name one; upgrade the thwip CLI and run the tests again on the merge of your branch with the base",
        { statement },
      );
    }
    if (facts.mergeTreeOid === undefined) {
      return res(
        "SUBJECT_TREE_MISMATCH",
        "this project verifies the merged tree and the checker could not read the merge of this branch with the base from GitHub; retry once GitHub has computed the merge",
        { statement },
      );
    }
    if (claimed !== facts.mergeTreeOid) {
      return res(
        "SUBJECT_TREE_MISMATCH",
        `the proof names merge tree ${claimed} and GitHub merges this branch into the base as ${facts.mergeTreeOid}; run the tests again on the current merge`,
        { statement },
      );
    }
  }

  // 6. Policy binding.
  const policyEligible =
    pred.policy.digest === bundle.activePolicyDigest || bundle.gracePolicyDigests.includes(pred.policy.digest);
  if (!policyEligible) return res("POLICY_NOT_ACTIVE", pred.policy.digest, { statement });
  if (pred.git.evaluationMode !== bundle.policy.evaluationMode) {
    return res("POLICY_NOT_ACTIVE", "evaluation mode mismatch", { statement });
  }

  // 7. Pipeline binding.
  if (pred.pipeline.digest !== bundle.policy.pipeline.digest || pred.pipeline.runner !== bundle.policy.pipeline.runner) {
    return res("PIPELINE_DIGEST_MISMATCH", undefined, { statement });
  }

  // 8. Signer binding and current authorization.
  if (pred.signer.keyId !== keyid) return res("SIGNER_MISMATCH", "predicate keyId != envelope keyid", { statement });
  if (pred.signer.githubUserId !== key.githubUserId) {
    return res("SIGNER_MISMATCH", "predicate user != enrolled key user", { statement });
  }
  const grant = bundle.grants.find((g) => g.githubUserId === key.githubUserId);
  if (!grant || !grant.active) return res("SIGNER_PERMISSION_INSUFFICIENT", "no active grant", { statement });
  const need = PERMISSION_RANK[bundle.policy.minimumPermission] ?? 99;
  if ((PERMISSION_RANK[grant.permission] ?? 0) < need) {
    return res("SIGNER_PERMISSION_INSUFFICIENT", grant.permission, { statement });
  }
  if (!bundle.policy.allowAuthorAsSigner && facts.prAuthorGithubUserId === key.githubUserId) {
    return res("SIGNER_PERMISSION_INSUFFICIENT", "author may not sign", { statement });
  }
  if (bundle.policy.requireGithubKeyPresence) {
    if (!deps.githubUserSigningKeys) {
      return res(
        "SIGNER_KEY_UNKNOWN",
        "this project requires the signing key to be published on the signer's GitHub account and the checker cannot read GitHub's key list",
        { statement },
      );
    }
    let published: string[];
    try {
      published = await deps.githubUserSigningKeys(key.githubUserId);
    } catch {
      return res("SIGNER_KEY_UNKNOWN", "GitHub did not answer when asked which keys this signer publishes; try again", {
        statement,
      });
    }
    const wanted = sshKeyBody(key.publicKey);
    if (wanted === undefined || !published.some((line) => sshKeyBody(line) === wanted)) {
      return res(
        "SIGNER_KEY_UNKNOWN",
        `key ${key.keyId} is not among the SSH keys ${key.githubUserId} publishes on GitHub; add it to the GitHub account or enroll the key that is there`,
        { statement },
      );
    }
  }

  // 9. Required suites: each exactly once, each passed.
  const seen = new Set<string>();
  for (const s of pred.run.suites) {
    if (seen.has(s.id)) return res("SUITE_DUPLICATE", s.id, { statement });
    seen.add(s.id);
  }
  for (const required of bundle.policy.pipeline.requiredSuites) {
    const suite = pred.run.suites.find((s) => s.id === required);
    if (!suite) return res("SUITE_MISSING", required, { statement });
    if (suite.status !== "passed") return res("SUITE_NOT_PASSED", required, { statement });
  }

  // 10. Remote suites: proven by GitHub's own run, not by the signer. A check
  // GitHub has not concluded is not a failed check, and a read GitHub would not
  // answer says nothing at all, so both wait rather than rejecting work that is
  // fine. `settleRemoteSuites` holds that rule.
  const remoteSuites = bundle.policy.pipeline.remoteSuites ?? [];
  if (remoteSuites.length > 0) {
    const read = deps.remoteCheckConclusions;
    if (!read) {
      return res("SUITE_MISSING", "remote suites declared but no check reader available", { statement });
    }
    const settlement = await settleRemoteSuites(
      remoteSuites,
      {
        readConclusions: async () => {
          try {
            return await read(facts.headSha);
          } catch {
            return null;
          }
        },
      },
      deps.sleep !== undefined ? { sleep: deps.sleep } : {},
    );
    if (settlement.kind === "failed") return res("SUITE_NOT_PASSED", settlement.reason, { statement });
    if (settlement.kind === "unsettled") return res("VERIFICATION_PENDING", settlement.reason, { statement });
  }

  // 11. Run window and proof age. A run that finished after now, or before it
  // started, describes no real run, and a forward-dated one would sit inside
  // every age window forever.
  const started = Date.parse(pred.run.startedAt);
  const finished = Date.parse(pred.run.finishedAt);
  if (!Number.isFinite(finished)) return res("PROOF_MALFORMED", "finishedAt unparseable", { statement });
  if (!Number.isFinite(started)) return res("PROOF_MALFORMED", "startedAt unparseable", { statement });
  if (finished < started) {
    return res(
      "PROOF_MALFORMED",
      `the proof says the run finished at ${pred.run.finishedAt}, before it started at ${pred.run.startedAt}; check the clock on the machine that ran the tests and sign again`,
      { statement },
    );
  }
  if (finished > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
    return res(
      "PROOF_MALFORMED",
      `the proof says the run finished at ${pred.run.finishedAt}, which is in the future; check the clock on the machine that ran the tests and sign again`,
      { statement },
    );
  }
  if (nowMs - finished > bundle.policy.proofMaxAgeSeconds * 1000) {
    return res("PROOF_EXPIRED", undefined, { statement });
  }

  // 12. Lease. Where the policy requires one, it is the evidence that the run
  // happened inside a window this service opened for this exact tree, so every
  // part of it is checked: the signature under the project's issuer keys, the
  // age against `lease.maxAgeSeconds`, and the context against this run.
  if (bundle.policy.lease.required) {
    const lease = pred.run.lease;
    if (lease === undefined) {
      return res(
        "LEASE_REQUIRED",
        "this project requires a run lease and the proof carries none; run `thwip run` so the tests execute inside a lease",
        { statement },
      );
    }
    const verdict = await checkLease({ lease, bundle, facts, pred, nowMs, deps });
    if (verdict !== undefined) return { ...verdict, statement };
  }

  // 13. Audit. Where the policy selects this proof for audit, the merge waits
  // on an independent re-run that agrees with it.
  const audit = bundle.policy.audit;
  const mandatoryPaths = audit.mandatoryPaths ?? [];
  const basisPoints = audit.basisPoints ?? 0;
  if (mandatoryPaths.length > 0 || basisPoints > 0) {
    if (mandatoryPaths.length > 0 && facts.changedPaths === undefined) {
      return res(
        "AUDIT_REQUIRED",
        "this project audits changes under protected paths and the checker could not read which paths this branch changes; retry, and if it persists ask an administrator to check the GitHub App's contents permission",
        { statement },
      );
    }
    const touchesProtected = (facts.changedPaths ?? []).some((path) =>
      mandatoryPaths.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)),
    );
    if (touchesProtected || sampledForAudit(facts.treeOid, basisPoints)) {
      if (!deps.auditProof) {
        return res(
          "AUDIT_REQUIRED",
          "this project audits a share of proofs by re-running them and no auditor is available to this checker; ask an administrator to enable the audit runner or lower the audit rate",
          { statement },
        );
      }
      let outcome: { agrees: boolean; detail?: string };
      try {
        outcome = await deps.auditProof({ statement, facts });
      } catch {
        return res("AUDIT_REQUIRED", "the audit re-run did not complete, so this proof is unaudited; run it again", {
          statement,
        });
      }
      if (!outcome.agrees) {
        return res(
          "AUDIT_DISAGREED",
          outcome.detail ?? "an independent re-run of this pipeline disagreed with the proof; run the tests again and look at what differs",
          { statement },
        );
      }
    }
  }

  return res("PASS", undefined, { statement, signerKey: key });
}

/** A signer's clock may sit slightly ahead of the verifier's. Nothing more. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/** The audience the control plane mints run leases for. */
const LEASE_AUDIENCE = "urn:thwip:ci-run:v1";

const LEASE_ALGORITHMS = new Set(["ES256", "EdDSA"]);

/**
 * Deterministic per-tree sampling. Tree object ids are uniform over their hex
 * digits, so the leading 32 bits give the same verdict for the same tree on
 * every verifier, which keeps a re-run from dodging an audit.
 */
function sampledForAudit(treeOid: string, basisPoints: number): boolean {
  if (basisPoints <= 0) return false;
  if (basisPoints >= 10_000) return true;
  const bucket = Number.parseInt(treeOid.slice(0, 8), 16);
  if (!Number.isFinite(bucket)) return true;
  return bucket % 10_000 < basisPoints;
}

/** Key type and body of an authorized_keys line, without the trailing comment. */
function sshKeyBody(line: string): string | undefined {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  return `${parts[0]} ${parts[1]}`;
}

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return b64stdDecode(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

interface LeaseCheckInput {
  lease: string;
  bundle: VerificationBundleV1;
  facts: GithubFacts;
  pred: InTotoStatementV1["predicate"];
  nowMs: number;
  deps: VerifyDeps;
}

/**
 * Judge a run lease. Returns undefined when the lease holds, and the refusal
 * otherwise. Anything the check needs and does not have is a refusal.
 */
async function checkLease(input: LeaseCheckInput): Promise<VerifyResult | undefined> {
  const { lease, bundle, facts, pred, nowMs, deps } = input;
  const jwks = bundle.leaseIssuerJwks;
  if (jwks.length === 0) {
    return res(
      "LEASE_INVALID",
      "this project requires a run lease and carries no issuer keys to check one against; ask an administrator to reload the project's verification keys",
    );
  }
  if (!deps.verifyLeaseSignature) {
    return res(
      "LEASE_INVALID",
      "this project requires a run lease and this checker cannot verify lease signatures; update the thwip Action or App to a version that does",
    );
  }

  const parts = lease.split(".");
  if (parts.length !== 3) return res("LEASE_INVALID", "the lease in this proof is not a signed token; run `thwip run` again");
  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(utf8Decode(b64urlDecode(parts[0]!))) as { alg?: unknown; kid?: unknown };
    claims = JSON.parse(utf8Decode(b64urlDecode(parts[1]!))) as Record<string, unknown>;
  } catch {
    return res("LEASE_INVALID", "the lease in this proof cannot be read; run `thwip run` again to get a fresh one");
  }
  const alg = typeof header.alg === "string" ? header.alg : "";
  if (!LEASE_ALGORITHMS.has(alg)) {
    return res("LEASE_INVALID", `the lease is signed with ${alg || "no algorithm"}, which this project does not accept`);
  }

  const signingInput = utf8Encode(`${parts[0]}.${parts[1]}`);
  let signature: Uint8Array;
  try {
    signature = b64urlDecode(parts[2]!);
  } catch {
    return res("LEASE_INVALID", "the lease signature is not readable; run `thwip run` again to get a fresh lease");
  }
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const candidates = jwks.filter((jwk) => {
    if (kid === undefined) return true;
    const id = (jwk as { kid?: unknown } | null)?.kid;
    return typeof id !== "string" || id === kid;
  });
  let signatureOk = false;
  for (const jwk of candidates) {
    try {
      if (await deps.verifyLeaseSignature({ jwk, algorithm: alg, signingInput, signature })) {
        signatureOk = true;
        break;
      }
    } catch {
      /* try the next issuer key */
    }
  }
  if (!signatureOk) {
    return res(
      "LEASE_INVALID",
      "the lease in this proof was not signed by this project's lease issuer; run `thwip run` again so thwip mints the lease",
    );
  }

  // Age. `iat` bounds how long ago the service opened the window; `exp` and
  // `nbf` are the issuer's own bounds and both are enforced.
  const iat = typeof claims["iat"] === "number" ? claims["iat"] * 1000 : undefined;
  if (iat === undefined) {
    return res("LEASE_INVALID", "the lease does not say when it was issued, so its age cannot be judged; run `thwip run` again");
  }
  const maxAgeMs = bundle.policy.lease.maxAgeSeconds * 1000;
  if (nowMs - iat > maxAgeMs) {
    return res(
      "LEASE_EXPIRED",
      `this project accepts leases up to ${bundle.policy.lease.maxAgeSeconds} seconds old and this one was issued at ${new Date(iat).toISOString()}; run the tests again`,
    );
  }
  if (iat > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
    return res("LEASE_INVALID", "the lease says it was issued in the future; check the clock on this machine and run the tests again");
  }
  const exp = typeof claims["exp"] === "number" ? claims["exp"] * 1000 : undefined;
  if (exp === undefined) {
    return res("LEASE_INVALID", "the lease does not say when it expires; run `thwip run` again to get one that does");
  }
  if (exp < nowMs) {
    return res("LEASE_EXPIRED", `the lease expired at ${new Date(exp).toISOString()}; run the tests again to open a new window`);
  }
  const nbf = typeof claims["nbf"] === "number" ? claims["nbf"] * 1000 : undefined;
  if (nbf !== undefined && nbf > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
    return res("LEASE_EXPIRED", "the lease is not valid yet; check the clock on this machine and run the tests again");
  }
  // The run has to sit inside the window. A lease minted after the run ended
  // is a fresh wrapper around old evidence, which is what the lease exists to
  // stop.
  const finished = Date.parse(pred.run.finishedAt);
  if (Number.isFinite(finished) && finished < iat - CLOCK_SKEW_TOLERANCE_MS) {
    return res(
      "LEASE_CONTEXT_MISMATCH",
      `the run finished at ${pred.run.finishedAt}, before the lease was issued at ${new Date(iat).toISOString()}; run the tests again inside the lease`,
    );
  }

  // Context. A valid lease for some other run proves nothing about this one.
  const mismatch = (what: string, claimed: unknown, expected: string): VerifyResult =>
    res(
      "LEASE_CONTEXT_MISMATCH",
      `the lease was issued for ${what} ${String(claimed)} and this proof is for ${expected}; run the tests again on this branch`,
    );
  if (claims["aud"] !== LEASE_AUDIENCE) return mismatch("audience", claims["aud"], LEASE_AUDIENCE);
  if (claims["repositoryId"] !== facts.repositoryId) {
    return mismatch("repository", claims["repositoryId"], facts.repositoryId);
  }
  if (claims["treeOid"] !== facts.treeOid) return mismatch("tree", claims["treeOid"], facts.treeOid);
  if (claims["baseSha"] !== null && claims["baseSha"] !== undefined && claims["baseSha"] !== facts.baseSha) {
    return mismatch("base", claims["baseSha"], facts.baseSha);
  }
  const leaseParents = claims["parentOids"];
  if (
    Array.isArray(leaseParents) &&
    leaseParents.length > 0 &&
    (leaseParents.length !== facts.parentOids.length || leaseParents.some((p, i) => p !== facts.parentOids[i]))
  ) {
    return mismatch("parents", leaseParents.join(","), facts.parentOids.join(","));
  }
  if (claims["policyDigest"] !== undefined && claims["policyDigest"] !== pred.policy.digest) {
    return mismatch("policy", claims["policyDigest"], pred.policy.digest);
  }
  if (claims["deviceKeyId"] !== undefined && claims["deviceKeyId"] !== pred.signer.keyId) {
    return mismatch("device key", claims["deviceKeyId"], pred.signer.keyId);
  }
  return undefined;
}
