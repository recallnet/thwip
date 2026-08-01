import { CompactSign, exportJWK, generateKeyPair } from "jose";
import type { JSONWebKeySet } from "jose";
import { canonicalRecordBytes, envelopeDigest } from "@thwip/queue-protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { parseClaimResponse, verifyClaimedAssignment } from "./assignment.js";

/**
 * The claim response is the moment a device is told what to run. Everything
 * below exists because a device that believes the response is a device an
 * attacker only has to answer once.
 */

const D = (label: string) => `sha256:${(label.charCodeAt(0) % 10).toString().repeat(64)}`;
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const CANDIDATE_SHA = "3".repeat(40);
const CANDIDATE_TREE = "4".repeat(40);
const DEVICE = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = "2026-07-29T12:05:00Z";

function assignmentRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    assignmentId: "asg-1",
    attemptId: "att-1",
    repository: { ownerId: "162603603", repositoryId: "1315419165", baseRef: "refs/heads/main" },
    queue: {
      queueEpoch: 0,
      turnSequence: 5,
      entryId: "entry-1",
      pullRequestNumber: 42,
      sponsorPrincipalId: "alice",
      queueDecisionDigest: D("d"),
    },
    execution: { mode: "run", profile: "fresh", runnerPrincipalId: "alice", deviceKeyId: DEVICE },
    git: {
      objectFormat: "sha1",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      baseSha: BASE,
      headRepositoryId: "1315419165",
      headSha: HEAD,
      candidateSha: CANDIDATE_SHA,
      candidateTreeOid: CANDIDATE_TREE,
      candidateParentOids: [BASE, HEAD],
    },
    policy: {
      digest: D("p"),
      version: 4,
      securityProfile: "fresh",
      runner: "command",
      requiredSuites: ["lint", "test"],
    },
    evidence: { workReceiptDigest: D("w"), previousTransitionDigest: D("t") },
    timing: {
      issuedAt: "2026-07-29T12:00:00Z",
      notBefore: "2026-07-29T12:00:00Z",
      expiresAt: "2026-07-29T12:20:00Z",
    },
    nonce: "nonce-1",
    ...over,
  };
}

let keys: JSONWebKeySet;
let otherKeys: JSONWebKeySet;
let sign: (record: unknown) => Promise<string>;
let signWithOtherKey: (record: unknown) => Promise<string>;

beforeAll(async () => {
  const service = await generateKeyPair("ES256", { extractable: true });
  const impostor = await generateKeyPair("ES256", { extractable: true });
  keys = { keys: [{ ...(await exportJWK(service.publicKey)), alg: "ES256", kid: "svc" }] };
  otherKeys = { keys: [{ ...(await exportJWK(impostor.publicKey)), alg: "ES256", kid: "other" }] };
  sign = (record) =>
    new CompactSign(canonicalRecordBytes(record)).setProtectedHeader({ alg: "ES256", kid: "svc" }).sign(service.privateKey);
  signWithOtherKey = (record) =>
    new CompactSign(canonicalRecordBytes(record))
      .setProtectedHeader({ alg: "ES256", kid: "other" })
      .sign(impostor.privateKey);
});

async function claim(over: Record<string, unknown> = {}, record = assignmentRecord()): Promise<unknown> {
  return {
    assignmentId: "asg-1",
    assignmentDigest: await envelopeDigest(canonicalRecordBytes(record)),
    assignment: await sign(record),
    candidateSha: CANDIDATE_SHA,
    candidateTreeOid: CANDIDATE_TREE,
    requiredSuites: ["lint", "test"],
    executionSeconds: 900,
    ...over,
  };
}

const context = {
  deviceKeyId: DEVICE,
  repositoryId: "1315419165",
  attemptId: "att-1",
  now: NOW,
};

describe("parseClaimResponse", () => {
  it("reads a well-formed claim", async () => {
    expect(parseClaimResponse(await claim())).not.toBeNull();
  });

  it("reads nothing from a body that is not a claim", () => {
    expect(parseClaimResponse({ error: "ALREADY_CLAIMED" })).toBeNull();
    expect(parseClaimResponse(null)).toBeNull();
    expect(parseClaimResponse("ok")).toBeNull();
  });
});

describe("verifyClaimedAssignment", () => {
  it("accepts an assignment thwip signed for this device, and reports the candidate it names", async () => {
    const parsed = parseClaimResponse(await claim())!;
    const result = await verifyClaimedAssignment(parsed, { ...context, jwks: keys });
    expect(result).toMatchObject({
      ok: true,
      candidateSha: CANDIDATE_SHA,
      candidateTreeOid: CANDIDATE_TREE,
      requiredSuites: ["lint", "test"],
    });
  });

  it("refuses an assignment signed by a key thwip does not publish", async () => {
    const record = assignmentRecord();
    const parsed = parseClaimResponse(
      await claim({ assignment: await signWithOtherKey(record) }, record),
    )!;
    expect(await verifyClaimedAssignment(parsed, { ...context, jwks: keys })).toMatchObject({
      ok: false,
      reasonCode: "ASSIGNMENT_UNVERIFIED",
    });
  });

  it("refuses every assignment when the published keys are somebody else's", async () => {
    const parsed = parseClaimResponse(await claim())!;
    expect(await verifyClaimedAssignment(parsed, { ...context, jwks: otherKeys })).toMatchObject({
      ok: false,
      reasonCode: "ASSIGNMENT_UNVERIFIED",
    });
  });

  it("refuses a claim whose digest does not name the signed bytes", async () => {
    const parsed = parseClaimResponse(await claim({ assignmentDigest: D("x") }))!;
    expect(await verifyClaimedAssignment(parsed, { ...context, jwks: keys })).toMatchObject({
      ok: false,
      reasonCode: "ASSIGNMENT_UNVERIFIED",
    });
  });

  /**
   * The one that matters most: the envelope and the signed record disagree
   * about which tree to run. Taking the envelope's word would run whatever the
   * response asked for, which is the hole this whole path closes.
   */
  it("refuses a claim whose unsigned tree disagrees with the tree the assignment signs", async () => {
    const parsed = parseClaimResponse(await claim({ candidateTreeOid: "9".repeat(40) }))!;
    expect(await verifyClaimedAssignment(parsed, { ...context, jwks: keys })).toMatchObject({
      ok: false,
      reasonCode: "CANDIDATE_TREE_MISMATCH",
    });
  });

  it("refuses a claim whose unsigned candidate commit disagrees with the signed one", async () => {
    const parsed = parseClaimResponse(await claim({ candidateSha: "8".repeat(40) }))!;
    expect(await verifyClaimedAssignment(parsed, { ...context, jwks: keys })).toMatchObject({
      ok: false,
      reasonCode: "CANDIDATE_TREE_MISMATCH",
    });
  });

  it("takes the tree to run from the signed record, never from the envelope beside it", async () => {
    const record = assignmentRecord();
    const parsed = parseClaimResponse(await claim({}, record))!;
    const result = await verifyClaimedAssignment(parsed, { ...context, jwks: keys });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidateTreeOid).toBe(result.assignment.git.candidateTreeOid);
    expect(result.candidateSha).toBe(result.assignment.git.candidateSha);
  });

  it("runs the suites the signed policy names, not the ones the envelope lists", async () => {
    const parsed = parseClaimResponse(await claim({ requiredSuites: ["lint"] }))!;
    expect(await verifyClaimedAssignment(parsed, { ...context, jwks: keys })).toMatchObject({
      ok: false,
      reasonCode: "ASSIGNMENT_MISMATCH",
    });
  });

  it("refuses an assignment addressed to another device", async () => {
    const record = assignmentRecord({
      execution: { mode: "run", profile: "fresh", runnerPrincipalId: "alice", deviceKeyId: "SHA256:someone-else" },
    });
    const parsed = parseClaimResponse(await claim({}, record))!;
    expect(await verifyClaimedAssignment(parsed, { ...context, jwks: keys })).toMatchObject({
      ok: false,
      reasonCode: "DEVICE_MISMATCH",
    });
  });

  it("refuses an assignment for another attempt", async () => {
    const parsed = parseClaimResponse(await claim())!;
    expect(await verifyClaimedAssignment(parsed, { ...context, jwks: keys, attemptId: "att-9" })).toMatchObject({
      ok: false,
      reasonCode: "ASSIGNMENT_MISMATCH",
    });
  });

  it("refuses an assignment for another repository", async () => {
    const parsed = parseClaimResponse(await claim())!;
    expect(await verifyClaimedAssignment(parsed, { ...context, jwks: keys, repositoryId: "42" })).toMatchObject({
      ok: false,
      reasonCode: "ASSIGNMENT_MISMATCH",
    });
  });

  it("refuses an assignment that dispatches no work to a device", async () => {
    const record = assignmentRecord({
      policy: { digest: D("p"), version: 4, securityProfile: "fast", runner: "command", requiredSuites: ["lint", "test"] },
      execution: { mode: "reuse", originalReceiptDigest: D("r"), originalSignerKeyId: "key-9" },
    });
    const parsed = parseClaimResponse(await claim({}, record))!;
    expect(await verifyClaimedAssignment(parsed, { ...context, jwks: keys })).toMatchObject({
      ok: false,
      reasonCode: "ASSIGNMENT_MISMATCH",
    });
  });

  it("refuses an assignment whose window has closed", async () => {
    const parsed = parseClaimResponse(await claim())!;
    expect(
      await verifyClaimedAssignment(parsed, { ...context, jwks: keys, now: "2026-07-29T12:21:00Z" }),
    ).toMatchObject({ ok: false, reasonCode: "ASSIGNMENT_EXPIRED" });
  });

  it("refuses an assignment whose window has not opened", async () => {
    const parsed = parseClaimResponse(await claim())!;
    expect(
      await verifyClaimedAssignment(parsed, { ...context, jwks: keys, now: "2026-07-29T11:59:00Z" }),
    ).toMatchObject({ ok: false, reasonCode: "ASSIGNMENT_EXPIRED" });
  });

  it("refuses a signed payload that is not an assignment at all", async () => {
    const record = { schemaVersion: "1", assignmentId: "asg-1" };
    const parsed = parseClaimResponse(await claim({}, record))!;
    expect(await verifyClaimedAssignment(parsed, { ...context, jwks: keys })).toMatchObject({
      ok: false,
      reasonCode: "ASSIGNMENT_UNVERIFIED",
    });
  });
});
