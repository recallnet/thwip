import { envelopeDigest, parseIntegrationAssignment, recordDigest } from "@thwip/queue-protocol";
import type { GitSubject, Sha256 } from "@thwip/queue-protocol";
import { describe, expect, it } from "vitest";
import { signLocalRunAssignment } from "./assignment.js";

/**
 * The queue telling a developer's own machine what to run against the
 * integrated candidate under the `fresh` profile.
 *
 * This is what nothing produced before Phase 5 — the reason `verified-merge`
 * was unreachable. The policy is digested here rather than passed as a
 * value, so an assignment cannot bind a policy nobody resolved, and it has a
 * fixed lifetime so a runner cannot present it forever.
 */
const D = (c: string) => `sha256:${c.repeat(64)}` as Sha256;
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);

const git: GitSubject = {
  objectFormat: "sha1",
  repositoryId: "1315419165",
  baseRef: "refs/heads/main",
  baseSha: BASE,
  headRepositoryId: "1315419165",
  headSha: HEAD,
  candidateSha: "3".repeat(40),
  candidateTreeOid: "4".repeat(40),
  candidateParentOids: [BASE, HEAD],
};

const signer = { async sign(bytes: Uint8Array) { return `jws.${await envelopeDigest(bytes)}`; } };

function input(over: Partial<Parameters<typeof signLocalRunAssignment>[0]> = {}) {
  return {
    assignmentId: "asg-1",
    attemptId: "att-1",
    ownerId: "162603603",
    git,
    queue: {
      queueEpoch: 1,
      turnSequence: 4,
      entryId: "entry-1",
      pullRequestNumber: 82,
      sponsorPrincipalId: "prn_1",
      queueDecisionDigest: D("a"),
    },
    policy: {
      version: 4,
      securityProfile: "fresh" as const,
      runner: "command" as const,
      requiredSuites: ["lint", "test"],
      document: { schemaVersion: "1", securityProfile: "fresh", runner: "command" },
    },
    workReceiptDigest: D("d"),
    previousTransitionDigest: D("e"),
    issuedAt: "2026-07-31T12:00:00Z",
    executionSeconds: 1800,
    nonce: "nonce-1",
    runnerPrincipalId: "prn_1",
    deviceKeyId: "dev-1",
    signer,
    ...over,
  };
}

describe("the local-run assignment the queue signs", () => {
  it("parses as an assignment, so what is signed is what a runner will accept", async () => {
    const signed = await signLocalRunAssignment(input());
    if ("error" in signed) throw new Error(signed.error);
    const parsed = parseIntegrationAssignment(JSON.parse(new TextDecoder().decode(signed.bytes)));
    expect(parsed).toMatchObject({ ok: true });
  });

  it("carries no verifier, because a local run pins no GitHub workflow", async () => {
    const signed = await signLocalRunAssignment(input());
    if ("error" in signed) throw new Error(signed.error);
    const doc = JSON.parse(new TextDecoder().decode(signed.bytes)) as Record<string, unknown>;
    expect(doc).not.toHaveProperty("verifier");
  });

  it("binds the policy by digesting the document, not by taking a digest", async () => {
    const theInput = input();
    const signed = await signLocalRunAssignment(theInput);
    if ("error" in signed) throw new Error(signed.error);
    const doc = JSON.parse(new TextDecoder().decode(signed.bytes)) as { policy: { digest: string } };
    expect(doc.policy.digest).toBe(await recordDigest(theInput.policy.document));
  });

  it("expires, so a runner cannot present it forever", async () => {
    const theInput = input();
    const signed = await signLocalRunAssignment(theInput);
    if ("error" in signed) throw new Error(signed.error);
    const doc = JSON.parse(new TextDecoder().decode(signed.bytes)) as { timing: { expiresAt: string } };
    expect(Date.parse(doc.timing.expiresAt)).toBe(Date.parse(theInput.issuedAt) + 1800 * 1000);
  });

  it("refuses to sign an assignment the parser rejects", async () => {
    const broken = input({ git: { ...git, headSha: "not-an-oid" } });
    expect(await signLocalRunAssignment(broken)).toMatchObject({ error: expect.any(String) });
  });

  it("accepts a dagger-runner policy, binding its module and engine digests", async () => {
    const dagger = input({
      policy: {
        version: 4,
        securityProfile: "audited" as const,
        runner: "dagger" as const,
        daggerModuleDigest: D("b"),
        daggerEngineDigest: D("c"),
        requiredSuites: ["lint", "test"],
        document: { schemaVersion: "1", securityProfile: "audited", runner: "dagger" },
      },
    });
    const signed = await signLocalRunAssignment(dagger);
    if ("error" in signed) throw new Error(signed.error);
    const doc = JSON.parse(new TextDecoder().decode(signed.bytes)) as {
      policy: { daggerModuleDigest: string; daggerEngineDigest: string };
    };
    expect(doc.policy.daggerModuleDigest).toBe(D("b"));
    expect(doc.policy.daggerEngineDigest).toBe(D("c"));
  });
});
