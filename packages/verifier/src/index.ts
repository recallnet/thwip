import {
  DSSE_PAYLOAD_TYPE,
  LEASE_AUDIENCE,
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

import { verifyLeaseSignature as defaultLeaseSignatureCheck } from "./lease-signature.js";
import { verifySshSignature as defaultSshSignatureCheck } from "./ssh-signature.js";

export { verifyLeaseSignature } from "./lease-signature.js";
export { ed25519RawFromAuthorizedKey, sha256Fingerprint, verifySshSignature } from "./ssh-signature.js";

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
  /**
   * Numeric GitHub user id of the pull request author. A project that forbids
   * the author from signing their own work cannot be judged without it, so the
   * caller resolves it and the verifier refuses when it is absent.
   */
  prAuthorGithubUserId?: string;
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
   * public key. Optional: the package verifies Ed25519 signatures itself, so a
   * caller that passes nothing still gets a real check. A caller with OpenSSH
   * to hand may pass one that covers more key types.
   */
  verifySshSignature?(args: {
    publicKey: string;
    namespace: string;
    message: Uint8Array;
    signatureBase64: string;
  }): Promise<boolean>;
  /**
   * Verify one compact-JWS signing input against one JWK from
   * `bundle.leaseIssuerJwks`. The verifier parses the lease, chooses the
   * candidate keys and judges every claim itself; this only does the maths.
   * Optional, and only for tests: production uses the package's own WebCrypto
   * implementation, so a caller cannot disable the check by omitting it.
   */
  verifyLeaseSignature?(args: {
    jwk: unknown;
    algorithm: string;
    signingInput: Uint8Array;
    signature: Uint8Array;
  }): Promise<boolean>;
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
  const checkSshSignature = deps.verifySshSignature ?? defaultSshSignatureCheck;
  try {
    sigOk = await checkSshSignature({
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

  // 6. Pipeline binding. This and the required suites below are the two things
  // the proof carries that the policy can invalidate, so they are compared
  // against the policy in force right now.
  //
  // The proof's own `policy.digest` is not compared to the active one. It was,
  // and because the digest covers the whole policy document any edit at all
  // retired every proof already signed. A twenty-four hour grace list of
  // recently retired digests hid that, and cost two things: an edit that added
  // a required suite went unenforced for a day, and for that same day the merge
  // gate refused proofs the check still showed green. Every other field of the
  // policy is read from this bundle as the check runs, so a change to one takes
  // effect on the next check with no proof needing to be re-signed.
  if (pred.pipeline.digest !== bundle.policy.pipeline.digest || pred.pipeline.runner !== bundle.policy.pipeline.runner) {
    return res(
      "PIPELINE_DIGEST_MISMATCH",
      `this project now runs pipeline ${bundle.policy.pipeline.digest} on ${bundle.policy.pipeline.runner} and the proof ran ${pred.pipeline.digest} on ${pred.pipeline.runner}; run \`thwip run\` again`,
      { statement },
    );
  }

  // 7. Signer binding and current authorization.
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
  // The control is "somebody other than the author signed this". Judging it
  // needs the author, so a checker that does not know who opened the pull
  // request cannot judge it, and the merge waits rather than passing on a
  // comparison against nothing.
  if (!bundle.policy.allowAuthorAsSigner) {
    if (facts.prAuthorGithubUserId === undefined) {
      return res(
        "SIGNER_PERMISSION_INSUFFICIENT",
        "this project requires somebody other than the author to sign, and the checker could not find out who opened the pull request for this commit; re-run the check, and if it persists ask an administrator to check the GitHub App's pull request permission",
        { statement },
      );
    }
    if (facts.prAuthorGithubUserId === key.githubUserId) {
      return res("SIGNER_PERMISSION_INSUFFICIENT", "author may not sign", { statement });
    }
  }

  // 8. Required suites: each exactly once, each passed. Read from the policy in
  // force, so a suite added a minute ago is required a minute ago. Named in the
  // refusal, because the developer's next move is to run that suite.
  const seen = new Set<string>();
  for (const s of pred.run.suites) {
    if (seen.has(s.id)) return res("SUITE_DUPLICATE", s.id, { statement });
    seen.add(s.id);
  }
  for (const required of bundle.policy.pipeline.requiredSuites) {
    const suite = pred.run.suites.find((s) => s.id === required);
    if (!suite) {
      return res(
        "SUITE_MISSING",
        `this project requires ${required} and the proof does not report it; run \`thwip run\` again`,
        { statement },
      );
    }
    if (suite.status !== "passed") {
      return res("SUITE_NOT_PASSED", `${required} is ${suite.status} in this proof`, { statement });
    }
  }

  // 9. Remote suites: proven by GitHub's own run, not by the signer. A check
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

  // 10. Run window and proof age. A run that finished after now, or before it
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

  // 11. Lease. Where the policy requires one, it is the evidence that the run
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

  return res("PASS", undefined, { statement, signerKey: key });
}

/** A signer's clock may sit slightly ahead of the verifier's. Nothing more. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

const LEASE_ALGORITHMS = new Set(["ES256", "EdDSA"]);

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
  // No caller has to supply this. The check is arithmetic over WebCrypto with
  // nothing environmental in it, and making it injectable is how every caller
  // came to pass nothing and every lease came to refuse. A test may still
  // substitute one.
  const checkSignature = deps.verifyLeaseSignature ?? defaultLeaseSignatureCheck;

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
      if (await checkSignature({ jwk, algorithm: alg, signingInput, signature })) {
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
  if (claims["projectId"] !== bundle.projectId) {
    return mismatch("project incarnation", claims["projectId"], bundle.projectId);
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
