import {
  DSSE_PAYLOAD_TYPE,
  SSH_SIGN_NAMESPACE,
  b64stdDecode,
  dssePae,
  extractCarrier,
  parseStatement,
  utf8Decode,
  type EnrolledKey,
  type InTotoStatementV1,
  type ReasonCode,
  type VerificationBundleV1,
} from "@thwip/protocol";

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
}

export interface VerifyDeps {
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

  // Bundle freshness (authenticity is established by the adapter's JWS check).
  if (Date.parse(bundle.expiresAt) < nowMs) return res("BUNDLE_EXPIRED");

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

  // 10. Proof age (signer-asserted in fast profile; bounded anyway).
  const finished = Date.parse(pred.run.finishedAt);
  if (!Number.isFinite(finished)) return res("PROOF_MALFORMED", "finishedAt unparseable", { statement });
  if (nowMs - finished > bundle.policy.proofMaxAgeSeconds * 1000) {
    return res("PROOF_EXPIRED", undefined, { statement });
  }

  // 11. Lease requirement (fresh and stronger profiles).
  if (bundle.policy.lease.required && pred.run.lease === undefined) {
    return res("LEASE_REQUIRED", undefined, { statement });
  }

  return res("PASS", undefined, { statement, signerKey: key });
}
