import {
  BOUNDS,
  array,
  counter,
  decimalId,
  exactKeys,
  fail,
  isRecord,
  isoDateTime,
  literal,
  ok,
  opaqueId,
  parseGitSubject,
  requireKeys,
  sha256,
  type GitSubject,
  type ParseResult,
  type Sha256,
} from "./primitives.js";
import { QUEUE_PREDICATE_TYPES, canonicalRecordBytes, queueSigningBytes } from "./canonical.js";

/**
 * The Integration Receipt (plan.md §21.4) is what a runner signs after
 * integrating a candidate: which assignment it answered, which exact tree it
 * ran against, which suites passed, and under what conditions.
 *
 * It deliberately carries no log text, environment variables, absolute paths,
 * source, or secrets. Report digests are allowed and do not imply anyone stores
 * the reports.
 */

export const RECEIPT_NETWORK_MODES = ["disabled", "policy-egress-v1", "unrestricted-declared-v1"] as const;
export const RECEIPT_CACHE_MODES = ["disabled", "read-only-v1", "read-write-policy-v1"] as const;

export interface ReceiptSuite {
  readonly name: string;
  readonly outcome: "passed" | "failed";
  readonly durationMs: number;
  readonly reportDigest?: Sha256;
}

/**
 * The pipeline's own execution digests exist only when it is a Dagger
 * pipeline. A command pipeline — what every live policy resolves to today —
 * has no module and no engine to name, and fabricating one would bind the
 * receipt to a Dagger run that never happened. So the two digests are
 * refused for `runner: "command"`, not merely optional, mirroring
 * {@link AssignmentPolicy} in assignment.ts so the two schemas agree.
 */
export type ReceiptPolicy =
  | {
      readonly digest: Sha256;
      readonly runner: "command";
      readonly requiredSuites: readonly string[];
    }
  | {
      readonly digest: Sha256;
      readonly runner: "dagger";
      readonly daggerModuleDigest: Sha256;
      readonly daggerEngineDigest: Sha256;
      readonly requiredSuites: readonly string[];
    };

export interface IntegrationRunPredicateV1 {
  readonly assignmentId: string;
  readonly assignmentDigest: Sha256;
  readonly attemptId: string;
  readonly subject: GitSubject;
  readonly policy: ReceiptPolicy;
  readonly runner: {
    readonly principalId: string;
    readonly githubUserId: string;
    readonly deviceKeyId: string;
    readonly publicKeyFingerprint: string;
  };
  readonly run: {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly environmentClass: string;
    readonly networkMode: (typeof RECEIPT_NETWORK_MODES)[number];
    readonly cacheMode: (typeof RECEIPT_CACHE_MODES)[number];
    readonly suites: readonly ReceiptSuite[];
  };
  readonly previousWorkReceiptDigest: Sha256;
  readonly nonce: string;
}

const KEYS = [
  "assignmentId",
  "assignmentDigest",
  "attemptId",
  "subject",
  "policy",
  "runner",
  "run",
  "previousWorkReceiptDigest",
  "nonce",
] as const;

/** An OpenSSH fingerprint, which is how a key is named everywhere in thwip. */
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

function parseSuite(v: unknown, index: number): ParseResult<ReceiptSuite> {
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

const POLICY_KEYS_COMMON = ["digest", "runner", "requiredSuites"] as const;
const POLICY_KEYS_DAGGER = [...POLICY_KEYS_COMMON, "daggerModuleDigest", "daggerEngineDigest"] as const;

function parsePolicy(v: unknown): ParseResult<ReceiptPolicy> {
  if (!isRecord(v)) return fail("receipt.policy must be an object");
  const runner = literal(v["runner"], "receipt.policy.runner", ["command", "dagger"] as const);
  if (!runner.ok) return runner;

  const policyKeys = runner.value === "dagger" ? POLICY_KEYS_DAGGER : POLICY_KEYS_COMMON;
  const shape = exactKeys(v, "receipt.policy", policyKeys);
  if (!shape.ok) return shape;
  const present = requireKeys(v, "receipt.policy", policyKeys);
  if (!present.ok) return present;

  const digest = sha256(v["digest"], "receipt.policy.digest");
  if (!digest.ok) return digest;
  const requiredSuites = array(v["requiredSuites"], "receipt.policy.requiredSuites", BOUNDS.suiteEntries, (item, i) => {
    if (typeof item !== "string" || item.length === 0) return fail(`suite ${i} must be a string`);
    return ok(item);
  });
  if (!requiredSuites.ok) return requiredSuites;
  if (requiredSuites.value.length === 0) return fail("receipt.policy.requiredSuites must not be empty");

  if (runner.value === "command") {
    return ok({ digest: digest.value, runner: "command", requiredSuites: requiredSuites.value });
  }

  const moduleDigest = sha256(v["daggerModuleDigest"], "receipt.policy.daggerModuleDigest");
  if (!moduleDigest.ok) return moduleDigest;
  const engineDigest = sha256(v["daggerEngineDigest"], "receipt.policy.daggerEngineDigest");
  if (!engineDigest.ok) return engineDigest;
  return ok({
    digest: digest.value,
    runner: "dagger",
    daggerModuleDigest: moduleDigest.value,
    daggerEngineDigest: engineDigest.value,
    requiredSuites: requiredSuites.value,
  });
}

export function parseIntegrationReceipt(v: unknown): ParseResult<IntegrationRunPredicateV1> {
  if (!isRecord(v)) return fail("receipt must be an object");
  const shape = exactKeys(v, "receipt", KEYS);
  if (!shape.ok) return shape;
  const present = requireKeys(v, "receipt", KEYS);
  if (!present.ok) return present;

  const assignmentId = opaqueId(v["assignmentId"], "receipt.assignmentId");
  if (!assignmentId.ok) return assignmentId;
  const assignmentDigest = sha256(v["assignmentDigest"], "receipt.assignmentDigest");
  if (!assignmentDigest.ok) return assignmentDigest;
  const attemptId = opaqueId(v["attemptId"], "receipt.attemptId");
  if (!attemptId.ok) return attemptId;
  const nonce = opaqueId(v["nonce"], "receipt.nonce");
  if (!nonce.ok) return nonce;
  const previousWorkReceiptDigest = sha256(
    v["previousWorkReceiptDigest"],
    "receipt.previousWorkReceiptDigest",
  );
  if (!previousWorkReceiptDigest.ok) return previousWorkReceiptDigest;

  const subject = parseGitSubject(v["subject"], "receipt.subject");
  if (!subject.ok) return subject;

  const policy = parsePolicy(v["policy"]);
  if (!policy.ok) return policy;

  const runner = v["runner"];
  if (!isRecord(runner)) return fail("receipt.runner must be an object");
  const runnerShape = exactKeys(runner, "receipt.runner", [
    "principalId",
    "githubUserId",
    "deviceKeyId",
    "publicKeyFingerprint",
  ]);
  if (!runnerShape.ok) return runnerShape;
  const principalId = opaqueId(runner["principalId"], "receipt.runner.principalId");
  if (!principalId.ok) return principalId;
  const githubUserId = decimalId(runner["githubUserId"], "receipt.runner.githubUserId");
  if (!githubUserId.ok) return githubUserId;
  const deviceKeyId = opaqueId(runner["deviceKeyId"], "receipt.runner.deviceKeyId");
  if (!deviceKeyId.ok) return deviceKeyId;
  const fingerprint = runner["publicKeyFingerprint"];
  if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
    return fail("receipt.runner.publicKeyFingerprint must be an OpenSSH SHA256 fingerprint");
  }

  const run = v["run"];
  if (!isRecord(run)) return fail("receipt.run must be an object");
  const runShape = exactKeys(run, "receipt.run", [
    "startedAt",
    "finishedAt",
    "environmentClass",
    "networkMode",
    "cacheMode",
    "suites",
  ]);
  if (!runShape.ok) return runShape;
  const startedAt = isoDateTime(run["startedAt"], "receipt.run.startedAt");
  if (!startedAt.ok) return startedAt;
  const finishedAt = isoDateTime(run["finishedAt"], "receipt.run.finishedAt");
  if (!finishedAt.ok) return finishedAt;
  if (Date.parse(finishedAt.value) < Date.parse(startedAt.value)) {
    return fail("receipt.run finished before it started");
  }
  // A coarse class, not a machine description: no hostnames, no paths.
  const environmentClass = run["environmentClass"];
  if (typeof environmentClass !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(environmentClass)) {
    return fail("receipt.run.environmentClass must be a short lowercase class name");
  }
  const networkMode = literal(run["networkMode"], "receipt.run.networkMode", RECEIPT_NETWORK_MODES);
  if (!networkMode.ok) return networkMode;
  const cacheMode = literal(run["cacheMode"], "receipt.run.cacheMode", RECEIPT_CACHE_MODES);
  if (!cacheMode.ok) return cacheMode;
  const suites = array(run["suites"], "receipt.run.suites", BOUNDS.suiteEntries, parseSuite);
  if (!suites.ok) return suites;

  // Every required suite must appear exactly once. A receipt that omits or
  // repeats a required suite is not a statement about the policy it names.
  const seen = new Map<string, number>();
  for (const suite of suites.value) seen.set(suite.name, (seen.get(suite.name) ?? 0) + 1);
  for (const required of policy.value.requiredSuites) {
    const count = seen.get(required) ?? 0;
    if (count === 0) return fail(`receipt.run.suites is missing required suite ${required}`);
    if (count > 1) return fail(`receipt.run.suites repeats required suite ${required}`);
  }

  return ok({
    assignmentId: assignmentId.value,
    assignmentDigest: assignmentDigest.value,
    attemptId: attemptId.value,
    subject: subject.value,
    policy: policy.value,
    runner: {
      principalId: principalId.value,
      githubUserId: githubUserId.value,
      deviceKeyId: deviceKeyId.value,
      publicKeyFingerprint: fingerprint,
    },
    run: {
      startedAt: startedAt.value,
      finishedAt: finishedAt.value,
      environmentClass,
      networkMode: networkMode.value,
      cacheMode: cacheMode.value,
      suites: suites.value,
    },
    previousWorkReceiptDigest: previousWorkReceiptDigest.value,
    nonce: nonce.value,
  });
}

/** Did every required suite actually pass in this receipt? */
export function receiptSatisfiesPolicy(receipt: IntegrationRunPredicateV1): { ok: true } | { ok: false; detail: string } {
  for (const required of receipt.policy.requiredSuites) {
    const suite = receipt.run.suites.find((s) => s.name === required);
    if (suite === undefined) return { ok: false, detail: `suite ${required} is absent` };
    if (suite.outcome !== "passed") return { ok: false, detail: `suite ${required} did not pass` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */

/**
 * Fast-path reuse evidence (plan.md §21.5). It claims that work already proven
 * elsewhere applies to this candidate, and the equivalence is what makes that
 * claim checkable. The GitHub verifier recomputes this equality; the scheduler
 * asserting it is not enough.
 */
export interface ExactReceiptReuseV1 {
  readonly schemaVersion: "1";
  readonly assignmentId: string;
  readonly assignmentDigest: Sha256;
  readonly workReceiptDigest: Sha256;
  readonly equivalence: {
    readonly repositoryId: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly candidateTreeOid: string;
    readonly policyDigest: Sha256;
    readonly pipelineDigest: Sha256;
    readonly requiredSuitesDigest: Sha256;
  };
}

const REUSE_KEYS = ["schemaVersion", "assignmentId", "assignmentDigest", "workReceiptDigest", "equivalence"] as const;
const EQUIVALENCE_KEYS = [
  "repositoryId",
  "baseSha",
  "headSha",
  "candidateTreeOid",
  "policyDigest",
  "pipelineDigest",
  "requiredSuitesDigest",
] as const;

export function parseExactReceiptReuse(v: unknown): ParseResult<ExactReceiptReuseV1> {
  if (!isRecord(v)) return fail("reuse must be an object");
  const shape = exactKeys(v, "reuse", REUSE_KEYS);
  if (!shape.ok) return shape;
  const present = requireKeys(v, "reuse", REUSE_KEYS);
  if (!present.ok) return present;
  if (v["schemaVersion"] !== "1") return fail('reuse.schemaVersion must be "1"');

  const assignmentId = opaqueId(v["assignmentId"], "reuse.assignmentId");
  if (!assignmentId.ok) return assignmentId;
  const assignmentDigest = sha256(v["assignmentDigest"], "reuse.assignmentDigest");
  if (!assignmentDigest.ok) return assignmentDigest;
  const workReceiptDigest = sha256(v["workReceiptDigest"], "reuse.workReceiptDigest");
  if (!workReceiptDigest.ok) return workReceiptDigest;

  const equivalence = v["equivalence"];
  if (!isRecord(equivalence)) return fail("reuse.equivalence must be an object");
  const eqShape = exactKeys(equivalence, "reuse.equivalence", EQUIVALENCE_KEYS);
  if (!eqShape.ok) return eqShape;
  const eqPresent = requireKeys(equivalence, "reuse.equivalence", EQUIVALENCE_KEYS);
  if (!eqPresent.ok) return eqPresent;

  const repositoryId = decimalId(equivalence["repositoryId"], "reuse.equivalence.repositoryId");
  if (!repositoryId.ok) return repositoryId;
  const oids: Record<string, string> = {};
  for (const key of ["baseSha", "headSha", "candidateTreeOid"] as const) {
    const value = equivalence[key];
    if (typeof value !== "string" || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
      return fail(`reuse.equivalence.${key} must be a lowercase hex object id`);
    }
    oids[key] = value;
  }
  const digests: Record<string, Sha256> = {};
  for (const key of ["policyDigest", "pipelineDigest", "requiredSuitesDigest"] as const) {
    const digest = sha256(equivalence[key], `reuse.equivalence.${key}`);
    if (!digest.ok) return digest;
    digests[key] = digest.value;
  }

  return ok({
    schemaVersion: "1",
    assignmentId: assignmentId.value,
    assignmentDigest: assignmentDigest.value,
    workReceiptDigest: workReceiptDigest.value,
    equivalence: {
      repositoryId: repositoryId.value,
      baseSha: oids["baseSha"]!,
      headSha: oids["headSha"]!,
      candidateTreeOid: oids["candidateTreeOid"]!,
      policyDigest: digests["policyDigest"]!,
      pipelineDigest: digests["pipelineDigest"]!,
      requiredSuitesDigest: digests["requiredSuitesDigest"]!,
    },
  });
}

/**
 * Recompute the reuse equality against live facts. This is the check the
 * verifier must perform: if any bound value differs, the earlier work was done
 * on something else and reuse would certify a tree nobody integrated.
 */
export function reuseEquivalenceHolds(
  reuse: ExactReceiptReuseV1,
  live: {
    readonly repositoryId: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly candidateTreeOid: string;
    readonly policyDigest: Sha256;
    readonly pipelineDigest: Sha256;
    readonly requiredSuitesDigest: Sha256;
  },
): { holds: true } | { holds: false; reason: string } {
  const fields = [
    "repositoryId",
    "baseSha",
    "headSha",
    "candidateTreeOid",
    "policyDigest",
    "pipelineDigest",
    "requiredSuitesDigest",
  ] as const;
  for (const field of fields) {
    if (reuse.equivalence[field] !== live[field]) {
      return { holds: false, reason: `reuse equivalence differs on ${field}` };
    }
  }
  return { holds: true };
}

/**
 * The five fields that are a device's integration receipt.
 *
 * The device signs these and the queue verifies that signature, from different
 * packages. They agreed once by coincidence: the command line tool signed
 * whatever its receipt object held, and the control plane signed five fields it
 * picked out again by hand. Adding a field on either side would have refused
 * every receipt, with both packages' own tests still green, because neither
 * could see the other.
 */
export interface IntegrationReceiptFields {
  readonly assignmentId: string;
  readonly assignmentDigest: string;
  readonly candidateTreeOid: string;
  readonly deviceKeyId: string;
  readonly suites: readonly { readonly name: string; readonly outcome: string }[];
}

/** Exactly what is signed: the receipt as content, and nothing sent alongside it. */
export function integrationReceiptContent(receipt: IntegrationReceiptFields): Record<string, unknown> {
  return {
    assignmentId: receipt.assignmentId,
    assignmentDigest: receipt.assignmentDigest,
    candidateTreeOid: receipt.candidateTreeOid,
    deviceKeyId: receipt.deviceKeyId,
    suites: receipt.suites.map((s) => ({ name: s.name, outcome: s.outcome })),
  };
}

/**
 * The bytes a device signs and the queue verifies.
 *
 * The pre-authentication encoding names the integration-run predicate, which is
 * what stops a signature over one kind of thwip record being replayed as
 * another.
 */
export function integrationReceiptSigningBytes(receipt: IntegrationReceiptFields): Uint8Array {
  return queueSigningBytes(QUEUE_PREDICATE_TYPES.integrationRun, canonicalRecordBytes(integrationReceiptContent(receipt)));
}
