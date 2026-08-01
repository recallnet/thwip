import { compactVerify, createLocalJWKSet, type JSONWebKeySet } from "jose";
import {
  assignmentWindow,
  envelopeDigest,
  parseIntegrationAssignment,
  type IntegrationAssignmentV1,
} from "@thwip/queue-protocol";

/**
 * What `POST /v1/queue/:repositoryId/claim` answers, and what this machine
 * checks before it acts on any of it.
 *
 * The service signs the assignment so a device can check it rather than
 * believe it. That distinction is the whole point of the `fresh` profile: a
 * CLI that runs whatever a response tells it to, against whatever tree the
 * response names, proves only that somebody answered an HTTP request. So
 * every value this module hands back comes out of the signed bytes, and the
 * unsigned fields beside them are treated as a claim to be checked, never as
 * an instruction.
 */

export interface ClaimEnvelope {
  readonly assignmentId: string;
  readonly assignmentDigest: string;
  /** The compact JWS the service signed the assignment with. */
  readonly assignment: string;
  readonly candidateSha: string;
  readonly candidateTreeOid: string;
  readonly requiredSuites: readonly string[];
  readonly executionSeconds: number;
}

export type AssignmentRefusal = {
  readonly ok: false;
  readonly reasonCode: "ASSIGNMENT_UNVERIFIED" | "ASSIGNMENT_MISMATCH" | "ASSIGNMENT_EXPIRED" | "DEVICE_MISMATCH" | "CANDIDATE_TREE_MISMATCH";
  readonly detail: string;
};

export interface AcceptedAssignment {
  readonly ok: true;
  readonly assignment: IntegrationAssignmentV1;
  readonly assignmentId: string;
  readonly assignmentDigest: string;
  /** From the signed record. The envelope's copy is only ever compared against this. */
  readonly candidateSha: string;
  readonly candidateTreeOid: string;
  readonly requiredSuites: readonly string[];
}

export interface ClaimContext {
  readonly jwks: JSONWebKeySet;
  readonly deviceKeyId: string;
  readonly repositoryId: string;
  readonly attemptId: string;
  readonly now: string;
}

/**
 * Read the wire shape, or nothing.
 *
 * A refusal body, an error page that returned 200, or a newer response this
 * build does not know all land here as nothing, so the caller reports a claim
 * it could not read instead of crashing on the first field it reaches for.
 *
 * `assignment` arrives either as the compact JWS itself or wrapped in an
 * object that carries one. Both are accepted because both are readings of "the
 * signed record", and the checks below run on the same bytes either way.
 */
export function parseClaimResponse(body: unknown): ClaimEnvelope | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const jws = readJws(b["assignment"]);
  if (jws === null) return null;
  if (typeof b["assignmentId"] !== "string" || b["assignmentId"].length === 0) return null;
  if (typeof b["assignmentDigest"] !== "string" || b["assignmentDigest"].length === 0) return null;
  if (typeof b["candidateSha"] !== "string" || typeof b["candidateTreeOid"] !== "string") return null;
  if (!Array.isArray(b["requiredSuites"]) || b["requiredSuites"].some((s) => typeof s !== "string")) return null;
  if (typeof b["executionSeconds"] !== "number") return null;
  return {
    assignmentId: b["assignmentId"],
    assignmentDigest: b["assignmentDigest"],
    assignment: jws,
    candidateSha: b["candidateSha"],
    candidateTreeOid: b["candidateTreeOid"],
    requiredSuites: b["requiredSuites"] as readonly string[],
    executionSeconds: b["executionSeconds"],
  };
}

function readJws(value: unknown): string | null {
  if (typeof value === "string" && value.split(".").length === 3) return value;
  if (typeof value === "object" && value !== null) {
    const jws = (value as Record<string, unknown>)["jws"];
    if (typeof jws === "string" && jws.split(".").length === 3) return jws;
  }
  return null;
}

/**
 * Check the assignment against thwip's published keys, then against this turn.
 *
 * The signature comes first, because nothing after it means anything until the
 * bytes are known to be thwip's. Then the digest, so the id the receipt will
 * cite names these exact bytes. Then the record itself, parsed from the signed
 * payload rather than from any object handed alongside it.
 */
export async function verifyClaimedAssignment(
  claim: ClaimEnvelope,
  context: ClaimContext,
): Promise<AcceptedAssignment | AssignmentRefusal> {
  let payload: Uint8Array;
  try {
    const verified = await compactVerify(claim.assignment, createLocalJWKSet(context.jwks));
    payload = verified.payload;
  } catch {
    return refuse(
      "ASSIGNMENT_UNVERIFIED",
      "the signature on this assignment does not check out against the keys thwip publishes",
    );
  }

  const digest = await envelopeDigest(payload);
  if (digest !== claim.assignmentDigest) {
    return refuse(
      "ASSIGNMENT_UNVERIFIED",
      `the claim names assignment ${claim.assignmentDigest}, and the bytes thwip signed digest to ${digest}`,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payload)) as unknown;
  } catch {
    return refuse("ASSIGNMENT_UNVERIFIED", "the signed assignment is not JSON");
  }
  const parsed = parseIntegrationAssignment(decoded);
  if (!parsed.ok) {
    return refuse("ASSIGNMENT_UNVERIFIED", `the signed assignment does not parse: ${parsed.detail}`);
  }
  const assignment = parsed.value;

  if (assignment.assignmentId !== claim.assignmentId) {
    return refuse(
      "ASSIGNMENT_MISMATCH",
      `the claim names assignment ${claim.assignmentId} and the signed record names ${assignment.assignmentId}`,
    );
  }
  if (assignment.attemptId !== context.attemptId) {
    return refuse(
      "ASSIGNMENT_MISMATCH",
      `this assignment covers attempt ${assignment.attemptId}, and this run is attempt ${context.attemptId}`,
    );
  }
  if (assignment.repository.repositoryId !== context.repositoryId) {
    return refuse(
      "ASSIGNMENT_MISMATCH",
      `this assignment covers repository ${assignment.repository.repositoryId}, and this checkout is repository ${context.repositoryId}`,
    );
  }
  if (assignment.execution.mode !== "run") {
    return refuse(
      "ASSIGNMENT_MISMATCH",
      `this assignment executes as ${assignment.execution.mode}, so it dispatches no work to this machine`,
    );
  }
  if (assignment.execution.deviceKeyId !== context.deviceKeyId) {
    return refuse(
      "DEVICE_MISMATCH",
      `this assignment is addressed to device ${assignment.execution.deviceKeyId}, and this machine signs as ${context.deviceKeyId}`,
    );
  }

  // The unsigned copies decide nothing. They are compared so that a response
  // whose envelope points at another tree is reported rather than ignored: the
  // service and its own signature disagreeing is worth saying out loud.
  if (
    assignment.git.candidateTreeOid !== claim.candidateTreeOid ||
    assignment.git.candidateSha !== claim.candidateSha
  ) {
    return refuse(
      "CANDIDATE_TREE_MISMATCH",
      `the claim asks for candidate ${claim.candidateSha} on tree ${claim.candidateTreeOid}, ` +
        `and the assignment thwip signed names ${assignment.git.candidateSha} on tree ${assignment.git.candidateTreeOid}`,
    );
  }

  const signedSuites = [...assignment.policy.requiredSuites].sort();
  const claimedSuites = [...claim.requiredSuites].sort();
  if (signedSuites.length !== claimedSuites.length || signedSuites.some((s, i) => s !== claimedSuites[i])) {
    return refuse(
      "ASSIGNMENT_MISMATCH",
      `the claim asks for suites ${claimedSuites.join(", ")}, and the signed policy requires ${signedSuites.join(", ")}`,
    );
  }

  const window = assignmentWindow(assignment, context.now);
  if (!window.usable) {
    return refuse(
      "ASSIGNMENT_EXPIRED",
      window.reason === "EXPIRED"
        ? `the execution window closed at ${assignment.timing.expiresAt}`
        : `the execution window opens at ${assignment.timing.notBefore}`,
    );
  }

  return {
    ok: true,
    assignment,
    assignmentId: assignment.assignmentId,
    assignmentDigest: digest,
    candidateSha: assignment.git.candidateSha,
    candidateTreeOid: assignment.git.candidateTreeOid,
    requiredSuites: assignment.policy.requiredSuites,
  };
}

function refuse(reasonCode: AssignmentRefusal["reasonCode"], detail: string): AssignmentRefusal {
  return { ok: false, reasonCode, detail };
}
