import {
  BOUNDS,
  array,
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
  positiveCounter,
  reasonCode,
  requireKeys,
  sha256,
  type ParseResult,
  type Sha256,
} from "./primitives.js";

/**
 * The Verifier Result (plan.md §21.6) is the only verdict the control plane will
 * act on, and it comes from a pinned GitHub workflow authenticated by OIDC.
 *
 * The rules that make it worth anything are about binding, not about the
 * verdict: the result names one attempt, one assignment digest, one candidate,
 * one nonce, and one kind of integration evidence whose digest it recomputed. A
 * result that is internally inconsistent — a remote profile with no independent
 * run, an accepted verdict over a failed suite — is rejected before it can
 * authorize a merge.
 *
 * The OIDC token authenticates this payload and is never stored afterwards.
 */

export const INTEGRATION_EVIDENCE_KINDS = [
  "integration-receipt",
  "exact-receipt-reuse",
  "independent-run",
] as const;
export type IntegrationEvidenceKind = (typeof INTEGRATION_EVIDENCE_KINDS)[number];

export const INDEPENDENT_RUN_PURPOSES = ["audited-rerun", "remote-primary"] as const;
export type IndependentRunPurpose = (typeof INDEPENDENT_RUN_PURPOSES)[number];

export const RUN_NETWORK_MODES = ["none", "policy-allowlist-v1"] as const;
export const RUN_CACHE_MODES = ["disabled", "read-only-v1", "read-write-policy-v1"] as const;

export interface SuiteOutcome {
  readonly name: string;
  readonly outcome: "passed" | "failed";
  readonly durationMs: number;
  readonly reportDigest?: Sha256;
}

export type IndependentRunFacts =
  | { readonly mode: "none" }
  | {
      readonly mode: "github-actions";
      readonly purpose: IndependentRunPurpose;
      readonly candidateSha: string;
      readonly candidateTreeOid: string;
      readonly pipelineDigest: Sha256;
      readonly daggerEngineDigest: Sha256;
      readonly requiredSuitesDigest: Sha256;
      readonly networkMode: (typeof RUN_NETWORK_MODES)[number];
      readonly cacheMode: (typeof RUN_CACHE_MODES)[number];
      readonly suites: readonly SuiteOutcome[];
      readonly startedAt: string;
      readonly completedAt: string;
    };

export interface VerifierResultV1 {
  readonly schemaVersion: "1";
  readonly attemptId: string;
  readonly assignmentDigest: Sha256;
  readonly integrationEvidenceKind: IntegrationEvidenceKind;
  readonly integrationEvidenceDigest: Sha256;
  readonly policyDigest: Sha256;
  readonly candidateSha: string;
  readonly candidateTreeOid: string;
  readonly verifierDigest: Sha256;
  readonly independentRun: IndependentRunFacts;
  readonly independentRunDigest: Sha256 | null;
  readonly verdict: "accepted" | "rejected";
  readonly reasonCodes: readonly string[];
  readonly github: {
    readonly repositoryId: string;
    readonly workflowRunId: string;
    readonly runAttempt: number;
    readonly workflowRef: string;
    readonly workflowSha: string;
    readonly jobWorkflowRef: string;
    readonly jobWorkflowSha: string;
    readonly oidcJti: string;
  };
  readonly observedAt: string;
  readonly nonce: string;
}

const KEYS = [
  "schemaVersion",
  "attemptId",
  "assignmentDigest",
  "integrationEvidenceKind",
  "integrationEvidenceDigest",
  "policyDigest",
  "candidateSha",
  "candidateTreeOid",
  "verifierDigest",
  "independentRun",
  "independentRunDigest",
  "verdict",
  "reasonCodes",
  "github",
  "observedAt",
  "nonce",
] as const;

const GITHUB_KEYS = [
  "repositoryId",
  "workflowRunId",
  "runAttempt",
  "workflowRef",
  "workflowSha",
  "jobWorkflowRef",
  "jobWorkflowSha",
  "oidcJti",
] as const;

function parseSuite(v: unknown, index: number): ParseResult<SuiteOutcome> {
  if (!isRecord(v)) return fail(`suite ${index} must be an object`);
  const shape = exactKeys(v, `suite ${index}`, ["name", "outcome", "durationMs", "reportDigest"]);
  if (!shape.ok) return shape;
  const name = v["name"];
  if (typeof name !== "string" || name.length === 0) return fail(`suite ${index} name is required`);
  if (new TextEncoder().encode(name).length > BOUNDS.suiteName) {
    return fail(`suite ${index} name exceeds ${BOUNDS.suiteName} bytes`);
  }
  const outcome = literal(v["outcome"], `suite ${index} outcome`, ["passed", "failed"] as const);
  if (!outcome.ok) return outcome;
  const durationMs = counter(v["durationMs"], `suite ${index} durationMs`);
  if (!durationMs.ok) return durationMs;
  if (v["reportDigest"] === undefined) {
    return ok({ name, outcome: outcome.value, durationMs: durationMs.value });
  }
  const reportDigest = sha256(v["reportDigest"], `suite ${index} reportDigest`);
  if (!reportDigest.ok) return reportDigest;
  return ok({ name, outcome: outcome.value, durationMs: durationMs.value, reportDigest: reportDigest.value });
}

function parseIndependentRun(v: unknown): ParseResult<IndependentRunFacts> {
  if (!isRecord(v)) return fail("result.independentRun must be an object");
  const mode = literal(v["mode"], "result.independentRun.mode", ["none", "github-actions"] as const);
  if (!mode.ok) return mode;

  if (mode.value === "none") {
    // A "none" run carries nothing else; extra fields would imply a run happened.
    const shape = exactKeys(v, "result.independentRun", ["mode"]);
    if (!shape.ok) return shape;
    return ok({ mode: "none" });
  }

  const shape = exactKeys(v, "result.independentRun", [
    "mode",
    "purpose",
    "candidateSha",
    "candidateTreeOid",
    "pipelineDigest",
    "daggerEngineDigest",
    "requiredSuitesDigest",
    "networkMode",
    "cacheMode",
    "suites",
    "startedAt",
    "completedAt",
  ]);
  if (!shape.ok) return shape;

  const purpose = literal(v["purpose"], "result.independentRun.purpose", INDEPENDENT_RUN_PURPOSES);
  if (!purpose.ok) return purpose;
  const candidateSha = gitOid(v["candidateSha"], "result.independentRun.candidateSha");
  if (!candidateSha.ok) return candidateSha;
  const candidateTreeOid = gitOid(v["candidateTreeOid"], "result.independentRun.candidateTreeOid");
  if (!candidateTreeOid.ok) return candidateTreeOid;
  const pipelineDigest = sha256(v["pipelineDigest"], "result.independentRun.pipelineDigest");
  if (!pipelineDigest.ok) return pipelineDigest;
  const daggerEngineDigest = sha256(v["daggerEngineDigest"], "result.independentRun.daggerEngineDigest");
  if (!daggerEngineDigest.ok) return daggerEngineDigest;
  const requiredSuitesDigest = sha256(v["requiredSuitesDigest"], "result.independentRun.requiredSuitesDigest");
  if (!requiredSuitesDigest.ok) return requiredSuitesDigest;
  const networkMode = literal(v["networkMode"], "result.independentRun.networkMode", RUN_NETWORK_MODES);
  if (!networkMode.ok) return networkMode;
  const cacheMode = literal(v["cacheMode"], "result.independentRun.cacheMode", RUN_CACHE_MODES);
  if (!cacheMode.ok) return cacheMode;
  const suites = array(v["suites"], "result.independentRun.suites", BOUNDS.suiteEntries, parseSuite);
  if (!suites.ok) return suites;
  if (suites.value.length === 0) return fail("result.independentRun.suites must not be empty");
  const names = suites.value.map((s) => s.name);
  if (new Set(names).size !== names.length) return fail("result.independentRun.suites repeats a suite");
  const startedAt = isoDateTime(v["startedAt"], "result.independentRun.startedAt");
  if (!startedAt.ok) return startedAt;
  const completedAt = isoDateTime(v["completedAt"], "result.independentRun.completedAt");
  if (!completedAt.ok) return completedAt;
  if (Date.parse(completedAt.value) < Date.parse(startedAt.value)) {
    return fail("result.independentRun completed before it started");
  }

  return ok({
    mode: "github-actions",
    purpose: purpose.value,
    candidateSha: candidateSha.value,
    candidateTreeOid: candidateTreeOid.value,
    pipelineDigest: pipelineDigest.value,
    daggerEngineDigest: daggerEngineDigest.value,
    requiredSuitesDigest: requiredSuitesDigest.value,
    networkMode: networkMode.value,
    cacheMode: cacheMode.value,
    suites: suites.value,
    startedAt: startedAt.value,
    completedAt: completedAt.value,
  });
}

/** A workflow ref must be a path pinned to a ref, so the identity is checkable. */
function workflowRef(v: unknown, name: string): ParseResult<string> {
  if (typeof v !== "string" || v.length === 0) return fail(`${name} is required`);
  if (new TextEncoder().encode(v).length > 512) return fail(`${name} exceeds 512 bytes`);
  if (!v.includes("/") || !v.includes("@")) return fail(`${name} must be owner/repo/path@ref`);
  return ok(v);
}

export function parseVerifierResult(v: unknown): ParseResult<VerifierResultV1> {
  if (!isRecord(v)) return fail("result must be an object");
  const shape = exactKeys(v, "result", KEYS);
  if (!shape.ok) return shape;
  const present = requireKeys(v, "result", KEYS);
  if (!present.ok) return present;
  if (v["schemaVersion"] !== "1") return fail('result.schemaVersion must be "1"');

  const attemptId = opaqueId(v["attemptId"], "result.attemptId");
  if (!attemptId.ok) return attemptId;
  const nonce = opaqueId(v["nonce"], "result.nonce");
  if (!nonce.ok) return nonce;
  const assignmentDigest = sha256(v["assignmentDigest"], "result.assignmentDigest");
  if (!assignmentDigest.ok) return assignmentDigest;
  const evidenceKind = literal(
    v["integrationEvidenceKind"],
    "result.integrationEvidenceKind",
    INTEGRATION_EVIDENCE_KINDS,
  );
  if (!evidenceKind.ok) return evidenceKind;
  const evidenceDigest = sha256(v["integrationEvidenceDigest"], "result.integrationEvidenceDigest");
  if (!evidenceDigest.ok) return evidenceDigest;
  const policyDigest = sha256(v["policyDigest"], "result.policyDigest");
  if (!policyDigest.ok) return policyDigest;
  const candidateSha = gitOid(v["candidateSha"], "result.candidateSha");
  if (!candidateSha.ok) return candidateSha;
  const candidateTreeOid = gitOid(v["candidateTreeOid"], "result.candidateTreeOid");
  if (!candidateTreeOid.ok) return candidateTreeOid;
  const verifierDigest = sha256(v["verifierDigest"], "result.verifierDigest");
  if (!verifierDigest.ok) return verifierDigest;

  const independentRun = parseIndependentRun(v["independentRun"]);
  if (!independentRun.ok) return independentRun;
  const independentRunDigest = nullableSha256(v["independentRunDigest"], "result.independentRunDigest");
  if (!independentRunDigest.ok) return independentRunDigest;

  const verdict = literal(v["verdict"], "result.verdict", ["accepted", "rejected"] as const);
  if (!verdict.ok) return verdict;
  const reasonCodes = array(v["reasonCodes"], "result.reasonCodes", BOUNDS.reasonCodeArray, (item, i) =>
    reasonCode(item, `reasonCodes[${i}]`),
  );
  if (!reasonCodes.ok) return reasonCodes;

  const github = v["github"];
  if (!isRecord(github)) return fail("result.github must be an object");
  const githubShape = exactKeys(github, "result.github", GITHUB_KEYS);
  if (!githubShape.ok) return githubShape;
  const githubPresent = requireKeys(github, "result.github", GITHUB_KEYS);
  if (!githubPresent.ok) return githubPresent;
  const repositoryId = decimalId(github["repositoryId"], "result.github.repositoryId");
  if (!repositoryId.ok) return repositoryId;
  const workflowRunId = decimalId(github["workflowRunId"], "result.github.workflowRunId");
  if (!workflowRunId.ok) return workflowRunId;
  const runAttempt = positiveCounter(github["runAttempt"], "result.github.runAttempt");
  if (!runAttempt.ok) return runAttempt;
  const wfRef = workflowRef(github["workflowRef"], "result.github.workflowRef");
  if (!wfRef.ok) return wfRef;
  const wfSha = gitOid(github["workflowSha"], "result.github.workflowSha");
  if (!wfSha.ok) return wfSha;
  const jobRef = workflowRef(github["jobWorkflowRef"], "result.github.jobWorkflowRef");
  if (!jobRef.ok) return jobRef;
  const jobSha = gitOid(github["jobWorkflowSha"], "result.github.jobWorkflowSha");
  if (!jobSha.ok) return jobSha;
  const oidcJti = opaqueId(github["oidcJti"], "result.github.oidcJti");
  if (!oidcJti.ok) return oidcJti;

  const observedAt = isoDateTime(v["observedAt"], "result.observedAt");
  if (!observedAt.ok) return observedAt;

  // Evidence kind and independent run must agree (§21.6).
  if (evidenceKind.value === "independent-run") {
    if (independentRun.value.mode !== "github-actions") {
      return fail("an independent-run result must carry an independent run");
    }
    if (independentRun.value.purpose !== "remote-primary") {
      return fail("an independent-run result must have purpose remote-primary");
    }
    if (independentRunDigest.value === null) {
      return fail("an independent-run result must digest its run");
    }
  } else if (independentRun.value.mode === "github-actions") {
    // Audited pairs a local receipt with an independent rerun; anything else
    // claiming a run alongside local evidence is not a shape the spec defines.
    if (independentRun.value.purpose !== "audited-rerun") {
      return fail("a local-evidence result may only carry an audited-rerun");
    }
    if (independentRunDigest.value === null) {
      return fail("an audited rerun must be digested");
    }
  } else if (independentRunDigest.value !== null) {
    return fail("result.independentRunDigest must be null when no independent run happened");
  }

  if (independentRun.value.mode === "github-actions") {
    if (independentRun.value.candidateSha !== candidateSha.value) {
      return fail("result.independentRun ran a different candidate");
    }
    if (independentRun.value.candidateTreeOid !== candidateTreeOid.value) {
      return fail("result.independentRun ran a different candidate tree");
    }
    // An accepted verdict cannot sit on top of a failed suite.
    if (verdict.value === "accepted" && independentRun.value.suites.some((s) => s.outcome === "failed")) {
      return fail("result cannot accept an independent run with a failed suite");
    }
  }

  if (verdict.value === "rejected" && reasonCodes.value.length === 0) {
    return fail("a rejected result must name at least one reason code");
  }
  if (verdict.value === "accepted" && reasonCodes.value.some((code) => code !== "PASS")) {
    return fail("an accepted result may only carry PASS");
  }

  return ok({
    schemaVersion: "1",
    attemptId: attemptId.value,
    assignmentDigest: assignmentDigest.value,
    integrationEvidenceKind: evidenceKind.value,
    integrationEvidenceDigest: evidenceDigest.value,
    policyDigest: policyDigest.value,
    candidateSha: candidateSha.value,
    candidateTreeOid: candidateTreeOid.value,
    verifierDigest: verifierDigest.value,
    independentRun: independentRun.value,
    independentRunDigest: independentRunDigest.value,
    verdict: verdict.value,
    reasonCodes: reasonCodes.value,
    github: {
      repositoryId: repositoryId.value,
      workflowRunId: workflowRunId.value,
      runAttempt: runAttempt.value,
      workflowRef: wfRef.value,
      workflowSha: wfSha.value,
      jobWorkflowRef: jobRef.value,
      jobWorkflowSha: jobSha.value,
      oidcJti: oidcJti.value,
    },
    observedAt: observedAt.value,
    nonce: nonce.value,
  });
}

/**
 * Is this result the answer to the question we asked? Checked separately from
 * shape because a well-formed result for a different attempt is exactly the
 * replay this binding exists to stop (§6.2 invariant 15, §23.1).
 */
export function resultBindsAttempt(
  result: VerifierResultV1,
  expected: {
    readonly attemptId: string;
    readonly nonce: string;
    readonly assignmentDigest: Sha256;
    readonly candidateSha: string;
    readonly candidateTreeOid: string;
    readonly policyDigest: Sha256;
    readonly verifierDigest: Sha256;
    readonly workflowRef: string;
    readonly workflowSha: string;
  },
): { bound: true } | { bound: false; reason: string } {
  const mismatch = (field: string) => ({ bound: false as const, reason: `verifier result ${field} mismatch` });
  if (result.attemptId !== expected.attemptId) return mismatch("attemptId");
  if (result.nonce !== expected.nonce) return mismatch("nonce");
  if (result.assignmentDigest !== expected.assignmentDigest) return mismatch("assignmentDigest");
  if (result.candidateSha !== expected.candidateSha) return mismatch("candidateSha");
  if (result.candidateTreeOid !== expected.candidateTreeOid) return mismatch("candidateTreeOid");
  if (result.policyDigest !== expected.policyDigest) return mismatch("policyDigest");
  if (result.verifierDigest !== expected.verifierDigest) return mismatch("verifierDigest");
  // The verdict is only trustworthy from the pinned workflow identity.
  if (result.github.workflowRef !== expected.workflowRef) return mismatch("workflowRef");
  if (result.github.workflowSha !== expected.workflowSha) return mismatch("workflowSha");
  return { bound: true };
}
