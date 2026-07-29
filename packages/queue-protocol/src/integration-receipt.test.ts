import { describe, expect, it } from "vitest";
import {
  parseExactReceiptReuse,
  parseIntegrationReceipt,
  receiptSatisfiesPolicy,
  reuseEquivalenceHolds,
} from "./integration-receipt.js";
import type { Sha256 } from "./primitives.js";

const hex = "0123456789abcdef";
const D = (label: string): Sha256 => `sha256:${hex[label.charCodeAt(0) % 16]!.repeat(64)}` as Sha256;
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "4".repeat(40);
const FINGERPRINT = "SHA256:nXERD2khQGOHccKTXtLUpsivMtnR2X1BSV6mLOeKfV4";

function receipt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assignmentId: "asg-1",
    assignmentDigest: D("a"),
    attemptId: "att-1",
    subject: {
      objectFormat: "sha1",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      baseSha: BASE,
      headRepositoryId: "1315419165",
      headSha: HEAD,
      candidateSha: "3".repeat(40),
      candidateTreeOid: TREE,
      candidateParentOids: [BASE, HEAD],
    },
    policy: {
      digest: D("c"),
      daggerModuleDigest: D("d"),
      daggerEngineDigest: D("e"),
      requiredSuites: ["lint", "test"],
    },
    runner: {
      principalId: "alice",
      githubUserId: "264261678",
      deviceKeyId: "key-1",
      publicKeyFingerprint: FINGERPRINT,
    },
    run: {
      startedAt: "2026-07-29T12:00:00Z",
      finishedAt: "2026-07-29T12:00:30Z",
      environmentClass: "macos-arm64-local",
      networkMode: "disabled",
      cacheMode: "read-only-v1",
      suites: [
        { name: "lint", outcome: "passed", durationMs: 200 },
        { name: "test", outcome: "passed", durationMs: 700 },
      ],
    },
    previousWorkReceiptDigest: D("f"),
    nonce: "nonce-1",
    ...over,
  };
}

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(receipt()["run"] as Record<string, unknown>), ...over };
}

describe("parseIntegrationReceipt", () => {
  it("accepts a well-formed receipt", () => {
    expect(parseIntegrationReceipt(receipt())).toMatchObject({ ok: true });
  });

  it("requires every required suite to be present exactly once", () => {
    const missing = receipt({
      run: run({ suites: [{ name: "lint", outcome: "passed", durationMs: 200 }] }),
    });
    const result = parseIntegrationReceipt(missing);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.detail).toMatch(/missing required suite test/);

    const repeated = receipt({
      run: run({
        suites: [
          { name: "lint", outcome: "passed", durationMs: 200 },
          { name: "lint", outcome: "passed", durationMs: 201 },
          { name: "test", outcome: "passed", durationMs: 700 },
        ],
      }),
    });
    expect(parseIntegrationReceipt(repeated)).toMatchObject({ ok: false });
  });

  it("accepts a receipt recording a failure, which is still a true statement", () => {
    const failed = receipt({
      run: run({
        suites: [
          { name: "lint", outcome: "passed", durationMs: 200 },
          { name: "test", outcome: "failed", durationMs: 700 },
        ],
      }),
    });
    expect(parseIntegrationReceipt(failed)).toMatchObject({ ok: true });
  });

  it("keeps environment detail coarse", () => {
    expect(
      parseIntegrationReceipt(receipt({ run: run({ environmentClass: "/Users/devrel/Projects/thwip" }) })),
    ).toMatchObject({ ok: false });
    expect(
      parseIntegrationReceipt(receipt({ run: run({ environmentClass: "Studio.local" }) })),
    ).toMatchObject({ ok: false });
  });

  it("requires an OpenSSH fingerprint for the signing key", () => {
    const runner = receipt()["runner"] as Record<string, unknown>;
    expect(
      parseIntegrationReceipt(receipt({ runner: { ...runner, publicKeyFingerprint: "key-1" } })),
    ).toMatchObject({ ok: false });
    expect(
      parseIntegrationReceipt(
        receipt({ runner: { ...runner, publicKeyFingerprint: `MD5:${"a".repeat(43)}` } }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects a run that finished before it started", () => {
    expect(
      parseIntegrationReceipt(
        receipt({ run: run({ startedAt: "2026-07-29T12:01:00Z", finishedAt: "2026-07-29T12:00:00Z" }) }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects an unknown network or cache mode", () => {
    expect(parseIntegrationReceipt(receipt({ run: run({ networkMode: "open" }) }))).toMatchObject({
      ok: false,
    });
    expect(parseIntegrationReceipt(receipt({ run: run({ cacheMode: "warm" }) }))).toMatchObject({
      ok: false,
    });
  });

  it("rejects any field that could leak run detail", () => {
    expect(parseIntegrationReceipt(receipt({ run: run({ log: "..." }) }))).toMatchObject({ ok: false });
    expect(parseIntegrationReceipt(receipt({ env: { HOME: "/Users/devrel" } }))).toMatchObject({
      ok: false,
    });
  });

  it("rejects more than thirty-two suites", () => {
    const many = receipt({
      policy: { ...(receipt()["policy"] as Record<string, unknown>), requiredSuites: ["lint"] },
      run: run({
        suites: Array.from({ length: 33 }, (_, i) => ({
          name: `s${i}`,
          outcome: "passed",
          durationMs: 1,
        })),
      }),
    });
    expect(parseIntegrationReceipt(many)).toMatchObject({ ok: false });
  });
});

describe("receiptSatisfiesPolicy", () => {
  it("passes when every required suite passed", () => {
    const parsed = parseIntegrationReceipt(receipt());
    expect(parsed.ok && receiptSatisfiesPolicy(parsed.value)).toEqual({ ok: true });
  });

  it("fails when a required suite failed", () => {
    const parsed = parseIntegrationReceipt(
      receipt({
        run: run({
          suites: [
            { name: "lint", outcome: "passed", durationMs: 1 },
            { name: "test", outcome: "failed", durationMs: 1 },
          ],
        }),
      }),
    );
    expect(parsed.ok && receiptSatisfiesPolicy(parsed.value)).toMatchObject({ ok: false });
  });
});

describe("exact receipt reuse", () => {
  const live = {
    repositoryId: "1315419165",
    baseSha: BASE,
    headSha: HEAD,
    candidateTreeOid: TREE,
    policyDigest: D("c"),
    pipelineDigest: D("9"),
    requiredSuitesDigest: D("8"),
  };

  function reuse(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: "1",
      assignmentId: "asg-1",
      assignmentDigest: D("a"),
      workReceiptDigest: D("b"),
      equivalence: { ...live },
      ...over,
    };
  }

  it("accepts a well-formed reuse claim", () => {
    expect(parseExactReceiptReuse(reuse())).toMatchObject({ ok: true });
  });

  it("rejects a missing or unknown equivalence field", () => {
    const { repositoryId: _drop, ...partial } = live;
    expect(parseExactReceiptReuse(reuse({ equivalence: partial }))).toMatchObject({ ok: false });
    expect(
      parseExactReceiptReuse(reuse({ equivalence: { ...live, closeEnough: true } })),
    ).toMatchObject({ ok: false });
  });

  it("holds only when every bound value matches live facts", () => {
    const parsed = parseExactReceiptReuse(reuse());
    expect(parsed.ok && reuseEquivalenceHolds(parsed.value, live)).toEqual({ holds: true });

    for (const field of Object.keys(live) as Array<keyof typeof live>) {
      const changed = {
        ...live,
        [field]: field.endsWith("Digest") ? D("0") : field === "repositoryId" ? "999" : "9".repeat(40),
      };
      const result = parsed.ok ? reuseEquivalenceHolds(parsed.value, changed) : { holds: true };
      expect(result).toMatchObject({ holds: false });
    }
  });
});
