import { describe, expect, it } from "vitest";
import {
  BOUNDS,
  baseRef,
  boundedString,
  byteLength,
  decimalId,
  exactKeys,
  gitOid,
  isoDateTime,
  parseGitSubject,
  reasonText,
  sha256,
} from "./primitives.js";

const SHA1 = "a".repeat(40);
const SHA256_OID = "b".repeat(64);

function subject(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectFormat: "sha1",
    repositoryId: "1315419165",
    baseRef: "refs/heads/main",
    baseSha: "1".repeat(40),
    headRepositoryId: "1315419165",
    headSha: "2".repeat(40),
    candidateSha: "3".repeat(40),
    candidateTreeOid: "4".repeat(40),
    candidateParentOids: ["1".repeat(40), "2".repeat(40)],
    ...over,
  };
}

describe("bounds", () => {
  it("measures UTF-8 bytes after NFC normalization, not code units", () => {
    // "é" as e + combining acute normalizes to one code point, two bytes.
    expect(byteLength("é")).toBe(2);
    expect(byteLength("🔒")).toBe(4);
  });

  it("rejects a reason that is within the character limit but over the byte limit", () => {
    const emoji = "🔒".repeat(BOUNDS.reason / 4);
    expect(reasonText(emoji, "reason").ok).toBe(true);
    expect(reasonText(emoji + "🔒", "reason")).toMatchObject({ ok: false });
  });

  it("never truncates: an oversize value is refused outright", () => {
    const result = boundedString("x".repeat(BOUNDS.opaqueId + 1), "id", BOUNDS.opaqueId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/exceeds 64 bytes/);
  });

  it("rejects a blank reason", () => {
    expect(reasonText("   ", "reason")).toMatchObject({ ok: false });
  });
});

describe("identifiers", () => {
  it("accepts decimal GitHub ids as strings only", () => {
    expect(decimalId("264261678", "id")).toMatchObject({ ok: true });
    expect(decimalId(264261678 as unknown, "id")).toMatchObject({ ok: false });
    expect(decimalId("26e5", "id")).toMatchObject({ ok: false });
    expect(decimalId("9".repeat(33), "id")).toMatchObject({ ok: false });
  });

  it("accepts only lowercase hex object ids of a valid width", () => {
    expect(gitOid(SHA1, "oid")).toMatchObject({ ok: true });
    expect(gitOid(SHA256_OID, "oid")).toMatchObject({ ok: true });
    expect(gitOid(SHA1.toUpperCase(), "oid")).toMatchObject({ ok: false });
    expect(gitOid("a".repeat(39), "oid")).toMatchObject({ ok: false });
    expect(gitOid("a".repeat(41), "oid")).toMatchObject({ ok: false });
  });

  it("requires the sha256: prefix on digests", () => {
    expect(sha256(`sha256:${"c".repeat(64)}`, "d")).toMatchObject({ ok: true });
    expect(sha256("c".repeat(64), "d")).toMatchObject({ ok: false });
    expect(sha256(`sha1:${"c".repeat(40)}`, "d")).toMatchObject({ ok: false });
  });

  it("requires a branch ref, not any ref", () => {
    expect(baseRef("refs/heads/main", "r")).toMatchObject({ ok: true });
    expect(baseRef("refs/tags/v1", "r")).toMatchObject({ ok: false });
    expect(baseRef("main", "r")).toMatchObject({ ok: false });
    expect(baseRef("refs/heads/", "r")).toMatchObject({ ok: false });
  });

  it("requires a UTC instant", () => {
    expect(isoDateTime("2026-07-29T12:00:00Z", "t")).toMatchObject({ ok: true });
    expect(isoDateTime("2026-07-29T12:00:00.123Z", "t")).toMatchObject({ ok: true });
    expect(isoDateTime("2026-07-29T12:00:00+01:00", "t")).toMatchObject({ ok: false });
    expect(isoDateTime("2026-07-29", "t")).toMatchObject({ ok: false });
  });
});

describe("exactKeys", () => {
  it("rejects a field belonging to another union variant", () => {
    const value = { kind: "verified", override: { reason: "x" } };
    expect(exactKeys(value, "intent", ["kind", "evidence"])).toMatchObject({ ok: false });
  });
});

describe("parseGitSubject", () => {
  it("accepts a well-formed sha1 subject", () => {
    expect(parseGitSubject(subject())).toMatchObject({ ok: true });
  });

  it("rejects an unknown field rather than stripping it", () => {
    const result = parseGitSubject(subject({ extra: true }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.detail).toMatch(/unexpected field extra/);
  });

  it("rejects a missing field", () => {
    const incomplete = subject();
    delete incomplete["candidateTreeOid"];
    expect(parseGitSubject(incomplete)).toMatchObject({ ok: false });
  });

  it("refuses sha256 object ids inside a sha1 subject", () => {
    const mixed = subject({ candidateTreeOid: SHA256_OID });
    const result = parseGitSubject(mixed);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.detail).toMatch(/not a sha1 object id/);
  });

  it("accepts a consistent sha256 subject", () => {
    const all256 = subject({
      objectFormat: "sha256",
      baseSha: "1".repeat(64),
      headSha: "2".repeat(64),
      candidateSha: "3".repeat(64),
      candidateTreeOid: "4".repeat(64),
      candidateParentOids: ["1".repeat(64)],
    });
    expect(parseGitSubject(all256)).toMatchObject({ ok: true });
  });

  it("requires at least the base parent and allows at most two", () => {
    expect(parseGitSubject(subject({ candidateParentOids: [] }))).toMatchObject({ ok: false });
    expect(
      parseGitSubject(
        subject({ candidateParentOids: ["1".repeat(40), "2".repeat(40), "3".repeat(40)] }),
      ),
    ).toMatchObject({ ok: false });
  });
});
