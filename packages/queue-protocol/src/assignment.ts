import {
  BOUNDS,
  array,
  baseRef,
  counter,
  decimalId,
  exactKeys,
  fail,
  gitOid,
  isRecord,
  isoDateTime,
  literal,
  nullableSha256,
  ok,
  opaqueId,
  parseGitSubject,
  positiveCounter,
  requireKeys,
  sha256,
  type GitSubject,
  type ParseResult,
  type Sha256,
} from "./primitives.js";
import { SECURITY_PROFILES, type SecurityProfile } from "./merge-intent.js";

/**
 * The Integration Assignment (plan.md §21.3) is the service's signed
 * instruction: run exactly this candidate, under exactly this policy, before
 * exactly this deadline, and report under this nonce.
 *
 * The CLI validates all of it before touching the candidate, because an
 * assignment is also the thing that stops a client integrating something it
 * chose for itself.
 */

export const EXECUTION_MODES = ["run", "reuse", "remote"] as const;
export type AssignmentExecutionMode = (typeof EXECUTION_MODES)[number];

export type AssignmentExecution =
  | { readonly mode: "run"; readonly profile: "fresh" | "audited"; readonly runnerPrincipalId: string; readonly deviceKeyId: string }
  | { readonly mode: "reuse"; readonly originalReceiptDigest: Sha256; readonly originalSignerKeyId: string }
  | { readonly mode: "remote"; readonly provider: "github-actions"; readonly workflowRef: string; readonly workflowSha: string };

/**
 * The pipeline's own execution digests exist only when it is a Dagger
 * pipeline. A command pipeline — what every live policy resolves to today —
 * has no module and no engine to name, and fabricating one would bind the
 * assignment to a Dagger run that never happens. So the two digests are
 * refused for `runner: "command"`, not merely optional, in the same style the
 * transition-record kinds refuse fields they cannot honestly hold.
 */
export type AssignmentPolicy =
  | {
      readonly digest: Sha256;
      readonly version: number;
      readonly securityProfile: SecurityProfile;
      readonly runner: "command";
      readonly requiredSuites: readonly string[];
    }
  | {
      readonly digest: Sha256;
      readonly version: number;
      readonly securityProfile: SecurityProfile;
      readonly runner: "dagger";
      readonly daggerModuleDigest: Sha256;
      readonly daggerEngineDigest: Sha256;
      readonly requiredSuites: readonly string[];
    };

/**
 * A GitHub Actions verifier exists only when the assignment actually runs
 * one — mode `remote`. A local `run` assignment (`fresh`, `audited`) executes
 * on a developer's own machine, where there is no GitHub workflow to pin, so
 * this block is refused rather than filled in with something nobody pinned.
 */
export interface AssignmentVerifier {
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly reusableWorkflowRef: string;
  readonly reusableWorkflowSha: string;
  readonly verifierDigest: Sha256;
}

export interface IntegrationAssignmentV1 {
  readonly schemaVersion: "1";
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly repository: { readonly ownerId: string; readonly repositoryId: string; readonly baseRef: string };
  readonly queue: {
    readonly queueEpoch: number;
    readonly turnSequence: number;
    readonly entryId: string;
    readonly pullRequestNumber: number;
    readonly sponsorPrincipalId: string;
    readonly queueDecisionDigest: Sha256;
  };
  readonly execution: AssignmentExecution;
  readonly git: GitSubject;
  readonly policy: AssignmentPolicy;
  readonly evidence: { readonly workReceiptDigest: Sha256; readonly previousTransitionDigest: Sha256 | null };
  /** Present only when `execution.mode` is `remote`; see {@link AssignmentVerifier}. */
  readonly verifier?: AssignmentVerifier;
  readonly timing: { readonly issuedAt: string; readonly notBefore: string; readonly expiresAt: string };
  readonly nonce: string;
}

const BASE_KEYS = [
  "schemaVersion",
  "assignmentId",
  "attemptId",
  "repository",
  "queue",
  "execution",
  "git",
  "policy",
  "evidence",
  "timing",
  "nonce",
] as const;

const POLICY_KEYS_COMMON = ["digest", "version", "securityProfile", "runner", "requiredSuites"] as const;
const POLICY_KEYS_DAGGER = [...POLICY_KEYS_COMMON, "daggerModuleDigest", "daggerEngineDigest"] as const;

const VERIFIER_KEYS = [
  "workflowRef",
  "workflowSha",
  "reusableWorkflowRef",
  "reusableWorkflowSha",
  "verifierDigest",
] as const;

/** A workflow ref must name an immutable path, not a floating branch. */
const WORKFLOW_REF_MAX = 512;

function workflowRef(v: unknown, name: string): ParseResult<string> {
  if (typeof v !== "string" || v.length === 0) return fail(`${name} is required`);
  if (new TextEncoder().encode(v).length > WORKFLOW_REF_MAX) return fail(`${name} exceeds ${WORKFLOW_REF_MAX} bytes`);
  if (!v.includes("/") || !v.includes("@")) return fail(`${name} must be owner/repo/path@ref`);
  return ok(v);
}

function parseExecution(v: unknown, profile: SecurityProfile): ParseResult<AssignmentExecution> {
  if (!isRecord(v)) return fail("assignment.execution must be an object");
  const mode = literal(v["mode"], "assignment.execution.mode", EXECUTION_MODES);
  if (!mode.ok) return mode;

  switch (mode.value) {
    case "run": {
      const shape = exactKeys(v, "assignment.execution", ["mode", "profile", "runnerPrincipalId", "deviceKeyId"]);
      if (!shape.ok) return shape;
      // Only fresh and audited are executed by a device under an assignment;
      // fast reuses evidence and remote runs on GitHub (§21.1).
      const runProfile = literal(v["profile"], "assignment.execution.profile", ["fresh", "audited"] as const);
      if (!runProfile.ok) return runProfile;
      if (runProfile.value !== profile) {
        return fail("assignment.execution.profile disagrees with the policy security profile");
      }
      const runnerPrincipalId = opaqueId(v["runnerPrincipalId"], "assignment.execution.runnerPrincipalId");
      if (!runnerPrincipalId.ok) return runnerPrincipalId;
      const deviceKeyId = opaqueId(v["deviceKeyId"], "assignment.execution.deviceKeyId");
      if (!deviceKeyId.ok) return deviceKeyId;
      return ok({
        mode: "run",
        profile: runProfile.value,
        runnerPrincipalId: runnerPrincipalId.value,
        deviceKeyId: deviceKeyId.value,
      });
    }

    case "reuse": {
      const shape = exactKeys(v, "assignment.execution", ["mode", "originalReceiptDigest", "originalSignerKeyId"]);
      if (!shape.ok) return shape;
      if (profile !== "fast") return fail("only the fast profile may reuse an existing receipt");
      const originalReceiptDigest = sha256(v["originalReceiptDigest"], "assignment.execution.originalReceiptDigest");
      if (!originalReceiptDigest.ok) return originalReceiptDigest;
      const originalSignerKeyId = opaqueId(v["originalSignerKeyId"], "assignment.execution.originalSignerKeyId");
      if (!originalSignerKeyId.ok) return originalSignerKeyId;
      return ok({
        mode: "reuse",
        originalReceiptDigest: originalReceiptDigest.value,
        originalSignerKeyId: originalSignerKeyId.value,
      });
    }

    case "remote": {
      const shape = exactKeys(v, "assignment.execution", ["mode", "provider", "workflowRef", "workflowSha"]);
      if (!shape.ok) return shape;
      if (profile !== "remote") return fail("only the remote profile may execute on a provider");
      const provider = literal(v["provider"], "assignment.execution.provider", ["github-actions"] as const);
      if (!provider.ok) return provider;
      const ref = workflowRef(v["workflowRef"], "assignment.execution.workflowRef");
      if (!ref.ok) return ref;
      const sha = gitOid(v["workflowSha"], "assignment.execution.workflowSha");
      if (!sha.ok) return sha;
      return ok({ mode: "remote", provider: provider.value, workflowRef: ref.value, workflowSha: sha.value });
    }
  }
}

function parsePolicy(v: unknown): ParseResult<AssignmentPolicy> {
  if (!isRecord(v)) return fail("assignment.policy must be an object");
  const runner = literal(v["runner"], "assignment.policy.runner", ["command", "dagger"] as const);
  if (!runner.ok) return runner;

  const shape = exactKeys(v, "assignment.policy", runner.value === "dagger" ? POLICY_KEYS_DAGGER : POLICY_KEYS_COMMON);
  if (!shape.ok) return shape;
  const present = requireKeys(
    v,
    "assignment.policy",
    runner.value === "dagger" ? POLICY_KEYS_DAGGER : POLICY_KEYS_COMMON,
  );
  if (!present.ok) return present;

  const digest = sha256(v["digest"], "assignment.policy.digest");
  if (!digest.ok) return digest;
  const version = positiveCounter(v["version"], "assignment.policy.version");
  if (!version.ok) return version;
  const securityProfile = literal(v["securityProfile"], "assignment.policy.securityProfile", SECURITY_PROFILES);
  if (!securityProfile.ok) return securityProfile;
  const requiredSuites = array(v["requiredSuites"], "assignment.policy.requiredSuites", BOUNDS.suiteEntries, (item, i) => {
    if (typeof item !== "string" || item.length === 0) return fail(`suite ${i} must be a string`);
    if (new TextEncoder().encode(item).length > BOUNDS.suiteName) return fail(`suite ${i} exceeds ${BOUNDS.suiteName} bytes`);
    return ok(item);
  });
  if (!requiredSuites.ok) return requiredSuites;
  if (requiredSuites.value.length === 0) return fail("assignment.policy.requiredSuites must name at least one suite");
  if (new Set(requiredSuites.value).size !== requiredSuites.value.length) {
    return fail("assignment.policy.requiredSuites must not repeat a suite");
  }

  if (runner.value === "command") {
    return ok({
      digest: digest.value,
      version: version.value,
      securityProfile: securityProfile.value,
      runner: "command",
      requiredSuites: requiredSuites.value,
    });
  }

  const moduleDigest = sha256(v["daggerModuleDigest"], "assignment.policy.daggerModuleDigest");
  if (!moduleDigest.ok) return moduleDigest;
  const engineDigest = sha256(v["daggerEngineDigest"], "assignment.policy.daggerEngineDigest");
  if (!engineDigest.ok) return engineDigest;
  return ok({
    digest: digest.value,
    version: version.value,
    securityProfile: securityProfile.value,
    runner: "dagger",
    daggerModuleDigest: moduleDigest.value,
    daggerEngineDigest: engineDigest.value,
    requiredSuites: requiredSuites.value,
  });
}

function parseVerifier(v: unknown): ParseResult<AssignmentVerifier> {
  if (!isRecord(v)) return fail("assignment.verifier must be an object");
  const shape = exactKeys(v, "assignment.verifier", VERIFIER_KEYS);
  if (!shape.ok) return shape;
  const present = requireKeys(v, "assignment.verifier", VERIFIER_KEYS);
  if (!present.ok) return present;
  const verifierWorkflowRef = workflowRef(v["workflowRef"], "assignment.verifier.workflowRef");
  if (!verifierWorkflowRef.ok) return verifierWorkflowRef;
  const verifierWorkflowSha = gitOid(v["workflowSha"], "assignment.verifier.workflowSha");
  if (!verifierWorkflowSha.ok) return verifierWorkflowSha;
  const reusableWorkflowRef = workflowRef(v["reusableWorkflowRef"], "assignment.verifier.reusableWorkflowRef");
  if (!reusableWorkflowRef.ok) return reusableWorkflowRef;
  const reusableWorkflowSha = gitOid(v["reusableWorkflowSha"], "assignment.verifier.reusableWorkflowSha");
  if (!reusableWorkflowSha.ok) return reusableWorkflowSha;
  const verifierDigest = sha256(v["verifierDigest"], "assignment.verifier.verifierDigest");
  if (!verifierDigest.ok) return verifierDigest;
  return ok({
    workflowRef: verifierWorkflowRef.value,
    workflowSha: verifierWorkflowSha.value,
    reusableWorkflowRef: reusableWorkflowRef.value,
    reusableWorkflowSha: reusableWorkflowSha.value,
    verifierDigest: verifierDigest.value,
  });
}

export function parseIntegrationAssignment(v: unknown): ParseResult<IntegrationAssignmentV1> {
  if (!isRecord(v)) return fail("assignment must be an object");

  // A verifier names a GitHub Actions workflow, which exists only when the
  // assignment actually dispatches one. Peeking the mode before the key check
  // lets a `remote` assignment carry the field and refuses it for every other
  // mode, rather than accepting it everywhere and hoping nobody fabricates one.
  const executionPeek = isRecord(v["execution"]) ? v["execution"]["mode"] : undefined;
  const verifierAllowed = executionPeek === "remote";
  const allowedKeys = verifierAllowed ? [...BASE_KEYS, "verifier"] : BASE_KEYS;

  const shape = exactKeys(v, "assignment", allowedKeys);
  if (!shape.ok) return shape;
  const present = requireKeys(v, "assignment", verifierAllowed ? [...BASE_KEYS, "verifier"] : BASE_KEYS);
  if (!present.ok) return present;
  if (v["schemaVersion"] !== "1") return fail('assignment.schemaVersion must be "1"');

  const assignmentId = opaqueId(v["assignmentId"], "assignment.assignmentId");
  if (!assignmentId.ok) return assignmentId;
  const attemptId = opaqueId(v["attemptId"], "assignment.attemptId");
  if (!attemptId.ok) return attemptId;
  const nonce = opaqueId(v["nonce"], "assignment.nonce");
  if (!nonce.ok) return nonce;

  const repository = v["repository"];
  if (!isRecord(repository)) return fail("assignment.repository must be an object");
  const repoShape = exactKeys(repository, "assignment.repository", ["ownerId", "repositoryId", "baseRef"]);
  if (!repoShape.ok) return repoShape;
  const ownerId = decimalId(repository["ownerId"], "assignment.repository.ownerId");
  if (!ownerId.ok) return ownerId;
  const repositoryId = decimalId(repository["repositoryId"], "assignment.repository.repositoryId");
  if (!repositoryId.ok) return repositoryId;
  const ref = baseRef(repository["baseRef"], "assignment.repository.baseRef");
  if (!ref.ok) return ref;

  const queue = v["queue"];
  if (!isRecord(queue)) return fail("assignment.queue must be an object");
  const queueShape = exactKeys(queue, "assignment.queue", [
    "queueEpoch",
    "turnSequence",
    "entryId",
    "pullRequestNumber",
    "sponsorPrincipalId",
    "queueDecisionDigest",
  ]);
  if (!queueShape.ok) return queueShape;
  const queueEpoch = counter(queue["queueEpoch"], "assignment.queue.queueEpoch");
  if (!queueEpoch.ok) return queueEpoch;
  const turnSequence = positiveCounter(queue["turnSequence"], "assignment.queue.turnSequence");
  if (!turnSequence.ok) return turnSequence;
  const entryId = opaqueId(queue["entryId"], "assignment.queue.entryId");
  if (!entryId.ok) return entryId;
  const pullRequestNumber = positiveCounter(queue["pullRequestNumber"], "assignment.queue.pullRequestNumber");
  if (!pullRequestNumber.ok) return pullRequestNumber;
  const sponsorPrincipalId = opaqueId(queue["sponsorPrincipalId"], "assignment.queue.sponsorPrincipalId");
  if (!sponsorPrincipalId.ok) return sponsorPrincipalId;
  const queueDecisionDigest = sha256(queue["queueDecisionDigest"], "assignment.queue.queueDecisionDigest");
  if (!queueDecisionDigest.ok) return queueDecisionDigest;

  const policy = parsePolicy(v["policy"]);
  if (!policy.ok) return policy;

  const execution = parseExecution(v["execution"], policy.value.securityProfile);
  if (!execution.ok) return execution;

  const git = parseGitSubject(v["git"], "assignment.git");
  if (!git.ok) return git;
  if (git.value.repositoryId !== repositoryId.value) {
    return fail("assignment.git.repositoryId disagrees with assignment.repository.repositoryId");
  }
  if (git.value.baseRef !== ref.value) {
    return fail("assignment.git.baseRef disagrees with assignment.repository.baseRef");
  }

  const evidence = v["evidence"];
  if (!isRecord(evidence)) return fail("assignment.evidence must be an object");
  const evidenceShape = exactKeys(evidence, "assignment.evidence", ["workReceiptDigest", "previousTransitionDigest"]);
  if (!evidenceShape.ok) return evidenceShape;
  const workReceiptDigest = sha256(evidence["workReceiptDigest"], "assignment.evidence.workReceiptDigest");
  if (!workReceiptDigest.ok) return workReceiptDigest;
  const previousTransitionDigest = nullableSha256(
    evidence["previousTransitionDigest"],
    "assignment.evidence.previousTransitionDigest",
  );
  if (!previousTransitionDigest.ok) return previousTransitionDigest;

  let verifier: AssignmentVerifier | undefined;
  if (verifierAllowed) {
    const parsedVerifier = parseVerifier(v["verifier"]);
    if (!parsedVerifier.ok) return parsedVerifier;
    verifier = parsedVerifier.value;
  }

  const timing = v["timing"];
  if (!isRecord(timing)) return fail("assignment.timing must be an object");
  const timingShape = exactKeys(timing, "assignment.timing", ["issuedAt", "notBefore", "expiresAt"]);
  if (!timingShape.ok) return timingShape;
  const issuedAt = isoDateTime(timing["issuedAt"], "assignment.timing.issuedAt");
  if (!issuedAt.ok) return issuedAt;
  const notBefore = isoDateTime(timing["notBefore"], "assignment.timing.notBefore");
  if (!notBefore.ok) return notBefore;
  const expiresAt = isoDateTime(timing["expiresAt"], "assignment.timing.expiresAt");
  if (!expiresAt.ok) return expiresAt;
  if (Date.parse(notBefore.value) < Date.parse(issuedAt.value)) {
    return fail("assignment.timing.notBefore precedes issuedAt");
  }
  if (Date.parse(expiresAt.value) <= Date.parse(notBefore.value)) {
    return fail("assignment.timing.expiresAt must follow notBefore");
  }
  // §9.2 allows 5 to 45 minutes of execution in v1; anything else is a bug or
  // an attempt to hold the lane indefinitely.
  const windowMs = Date.parse(expiresAt.value) - Date.parse(notBefore.value);
  if (windowMs < 5 * 60_000 || windowMs > 45 * 60_000) {
    return fail("assignment.timing execution window must be between 5 and 45 minutes");
  }

  return ok({
    schemaVersion: "1",
    assignmentId: assignmentId.value,
    attemptId: attemptId.value,
    repository: { ownerId: ownerId.value, repositoryId: repositoryId.value, baseRef: ref.value },
    queue: {
      queueEpoch: queueEpoch.value,
      turnSequence: turnSequence.value,
      entryId: entryId.value,
      pullRequestNumber: pullRequestNumber.value,
      sponsorPrincipalId: sponsorPrincipalId.value,
      queueDecisionDigest: queueDecisionDigest.value,
    },
    execution: execution.value,
    git: git.value,
    policy: policy.value,
    evidence: {
      workReceiptDigest: workReceiptDigest.value,
      previousTransitionDigest: previousTransitionDigest.value,
    },
    ...(verifier !== undefined ? { verifier } : {}),
    timing: { issuedAt: issuedAt.value, notBefore: notBefore.value, expiresAt: expiresAt.value },
    nonce: nonce.value,
  });
}

/**
 * Is this assignment usable right now? Separate from parsing, because an
 * assignment that is merely early or expired is well-formed — the CLI needs to
 * say which of the two it is (§21.3).
 */
export function assignmentWindow(
  assignment: IntegrationAssignmentV1,
  now: string,
): { usable: true } | { usable: false; reason: "TOO_EARLY" | "EXPIRED" } {
  const t = Date.parse(now);
  if (t < Date.parse(assignment.timing.notBefore)) return { usable: false, reason: "TOO_EARLY" };
  if (t >= Date.parse(assignment.timing.expiresAt)) return { usable: false, reason: "EXPIRED" };
  return { usable: true };
}
