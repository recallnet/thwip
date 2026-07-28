export type DecimalId = string;
export type GitOid = string;
export type Sha256 = `sha256:${string}`;
export type IsoDateTime = string;

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
export const PREDICATE_TYPE = "urn:thwip:attestation:ci-run:v1" as const;
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;
export const SSH_SIGN_NAMESPACE = "thwip-ci-dsse-v1" as const;
export const TRAILER_KEY = "thwip-Proof" as const;
export const CARRIER_VERSION = "v1" as const;

/** Encoded trailer value hard maximum (base64url chars). */
export const CARRIER_MAX_ENCODED = 32 * 1024;
/** Decoded DSSE envelope hard maximum (bytes). */
export const ENVELOPE_MAX_DECODED = 24 * 1024;

export interface SuiteResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  reportDigest?: Sha256;
}

export interface ThwipCiRunPredicateV1 {
  schemaVersion: "1";
  repository: {
    provider: "github";
    ownerId: DecimalId;
    repositoryId: DecimalId;
  };
  git: {
    objectFormat: "sha1" | "sha256";
    treeOid: GitOid;
    parentOids: GitOid[];
    baseRef: string;
    baseSha: GitOid;
    evaluationMode: "head-tree" | "merge-tree";
    mergeTreeOid?: GitOid;
  };
  policy: {
    digest: Sha256;
    version: number;
  };
  pipeline: {
    digest: Sha256;
    runner: "dagger" | "command";
  };
  run: {
    startedAt: IsoDateTime;
    finishedAt: IsoDateTime;
    lease?: string;
    networkMode: "disabled" | "restricted" | "unrestricted";
    cacheMode: "disabled" | "read-only" | "read-write";
    suites: SuiteResult[];
  };
  signer: {
    keyId: string;
    githubUserId: DecimalId;
  };
}

export interface InTotoStatementV1 {
  _type: typeof STATEMENT_TYPE;
  subject: Array<{ name: "git-tree"; digest: Partial<Record<"sha1" | "sha256", GitOid>> }>;
  predicateType: typeof PREDICATE_TYPE;
  predicate: ThwipCiRunPredicateV1;
}

export interface DsseEnvelope {
  payloadType: typeof DSSE_PAYLOAD_TYPE;
  /** standard base64 (padded) of the statement JSON bytes */
  payload: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

export interface PolicyBundleV1 {
  schemaVersion: "1";
  projectId: string;
  repositoryId: DecimalId;
  ownerId: DecimalId;
  version: number;
  securityProfile: "fast" | "fresh" | "audited" | "remote";
  minimumPermission: "triage" | "write" | "maintain" | "admin";
  allowAuthorAsSigner: boolean;
  evaluationMode: "head-tree" | "merge-tree";
  allowedKeyAlgorithms: string[];
  requireGithubKeyPresence: boolean;
  lease: { required: boolean; maxAgeSeconds: number };
  pipeline: {
    digest: Sha256;
    runner: "dagger" | "command";
    requiredSuites: string[];
  };
  proofMaxAgeSeconds: number;
  audit: { basisPoints: number; mandatoryPaths: string[] };
}

export interface EnrolledKey {
  keyId: string;
  githubUserId: DecimalId;
  algorithm: string;
  /** OpenSSH authorized_keys format public key, e.g. "ssh-ed25519 AAAA..." */
  publicKey: string;
  revokedAt: string | null;
}

export interface SignerGrant {
  githubUserId: DecimalId;
  permission: "none" | "read" | "triage" | "write" | "maintain" | "admin";
  active: boolean;
}

/** Signed facts the control plane returns; never a pass/fail decision. */
export interface VerificationBundleV1 {
  schemaVersion: "1";
  projectId: string;
  repositoryId: DecimalId;
  ownerId: DecimalId;
  activePolicyDigest: Sha256;
  gracePolicyDigests: Sha256[];
  policy: PolicyBundleV1;
  keys: EnrolledKey[];
  grants: SignerGrant[];
  leaseIssuerJwks: unknown[];
  issuedAt: IsoDateTime;
  expiresAt: IsoDateTime;
}

export const REASON_CODES = [
  "PASS",
  "PROOF_MISSING",
  "PROOF_DUPLICATE",
  "PROOF_TOO_LARGE",
  "PROOF_MALFORMED",
  "PROOF_SCHEMA_UNSUPPORTED",
  "SIGNATURE_INVALID",
  "SIGNER_KEY_UNKNOWN",
  "SIGNER_KEY_REVOKED",
  "SIGNER_KEY_ALGORITHM_FORBIDDEN",
  "SIGNER_MISMATCH",
  "SIGNER_PERMISSION_INSUFFICIENT",
  "SUBJECT_REPOSITORY_MISMATCH",
  "SUBJECT_TREE_MISMATCH",
  "SUBJECT_ANCESTRY_MISMATCH",
  "SUBJECT_BASE_MISMATCH",
  "POLICY_NOT_ACTIVE",
  "PIPELINE_DIGEST_MISMATCH",
  "SUITE_MISSING",
  "SUITE_DUPLICATE",
  "SUITE_NOT_PASSED",
  "PROOF_EXPIRED",
  "LEASE_REQUIRED",
  "LEASE_INVALID",
  "LEASE_EXPIRED",
  "LEASE_CONTEXT_MISMATCH",
  "AUDIT_REQUIRED",
  "AUDIT_DISAGREED",
  "BUNDLE_UNAVAILABLE",
  "BUNDLE_SIGNATURE_INVALID",
  "BUNDLE_EXPIRED",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];
