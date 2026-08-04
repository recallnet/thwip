import { describe, expect, it } from "vitest";
import { evidenceKey, putEvidence, type EvidenceKind, type R2Like } from "./evidence-store.js";
import type { Sha256 } from "@thwip/queue-protocol";

/**
 * Digest-addressed storage is only worth its complexity if the digest is checked
 * against the bytes. These tests make the dishonest case fail: bytes whose name
 * does not match them going in.
 */

function bucket() {
  const objects = new Map<string, Uint8Array>();
  const meta = new Map<string, Record<string, string>>();
  const impl: R2Like = {
    async put(key, value, options) {
      objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
      if (options?.customMetadata !== undefined) meta.set(key, options.customMetadata);
    },
    async head(key) {
      const bytes = objects.get(key);
      if (bytes === undefined) return null;
      const custom = meta.get(key);
      return custom === undefined
        ? { size: bytes.byteLength }
        : { size: bytes.byteLength, customMetadata: custom };
    },
  };
  return { impl, objects, meta };
}

const ORG = "org_1";
const REPO = "1315419165";
const KIND: EvidenceKind = "transition-record";

async function digest(bytes: Uint8Array): Promise<Sha256> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe("evidenceKey", () => {
  it("is tenant-scoped so an export or deletion can be bounded", () => {
    const key = evidenceKey({
      organizationId: ORG,
      repositoryId: REPO,
      kind: KIND,
      digest: `sha256:${"a".repeat(64)}`,
    });
    expect(key.startsWith(`org/${ORG}/repo/${REPO}/${KIND}/`)).toBe(true);
  });

  it("fans out on the digest so no single prefix grows without bound", () => {
    const key = evidenceKey({
      organizationId: ORG,
      repositoryId: REPO,
      kind: KIND,
      digest: `sha256:ab${"c".repeat(62)}`,
    });
    expect(key).toContain("/ab/ab");
  });

  it("separates repositories and kinds", () => {
    const base = { organizationId: ORG, digest: `sha256:${"a".repeat(64)}` as Sha256 };
    const a = evidenceKey({ ...base, repositoryId: "1", kind: "merge-intent" });
    const b = evidenceKey({ ...base, repositoryId: "2", kind: "merge-intent" });
    const c = evidenceKey({ ...base, repositoryId: "1", kind: "transition-record" });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("putEvidence", () => {
  it("stores bytes under their own digest", async () => {
    const { impl, objects } = bucket();
    const bytes = bytesOf('{"signed":"envelope"}');
    const result = await putEvidence(impl, {
      organizationId: ORG,
      repositoryId: REPO,
      kind: KIND,
      digest: await digest(bytes),
      bytes,
    });
    expect(result).toMatchObject({ stored: true, deduplicated: false });
    expect(objects.size).toBe(1);
  });

  it("refuses bytes whose name does not match them", async () => {
    // A mismatched pair would create evidence whose name lies about its content,
    // and every later reader would verify the wrong thing.
    const { impl, objects } = bucket();
    const bytes = bytesOf("real content");
    const result = await putEvidence(impl, {
      organizationId: ORG,
      repositoryId: REPO,
      kind: KIND,
      digest: `sha256:${"0".repeat(64)}`,
      bytes,
    });
    expect(result).toMatchObject({ stored: false, reason: "DIGEST_MISMATCH" });
    expect(objects.size).toBe(0);
  });

  it("treats a repeated write as a duplicate rather than an error", async () => {
    const { impl, objects } = bucket();
    const bytes = bytesOf("same");
    const input = {
      organizationId: ORG,
      repositoryId: REPO,
      kind: KIND,
      digest: await digest(bytes),
      bytes,
    };
    expect(await putEvidence(impl, input)).toMatchObject({ deduplicated: false });
    expect(await putEvidence(impl, input)).toMatchObject({ stored: true, deduplicated: true });
    expect(objects.size).toBe(1);
  });

  it("detects a bucket holding something that is not what its name says", async () => {
    const { impl, objects } = bucket();
    const bytes = bytesOf("the real envelope");
    const d = await digest(bytes);
    const key = evidenceKey({ organizationId: ORG, repositoryId: REPO, kind: KIND, digest: d });
    // Plant a different-length object at the right key, as corruption or a bug
    // elsewhere would.
    objects.set(key, bytesOf("something else entirely, longer"));

    expect(
      await putEvidence(impl, { organizationId: ORG, repositoryId: REPO, kind: KIND, digest: d, bytes }),
    ).toMatchObject({ stored: false, reason: "CONTENT_CONFLICT" });
  });

  it("records the kind and attempt in metadata, for auditing", async () => {
    const { impl, meta } = bucket();
    const bytes = bytesOf("x");
    await putEvidence(impl, {
      organizationId: ORG,
      repositoryId: REPO,
      kind: "merge-intent",
      digest: await digest(bytes),
      bytes,
      attemptId: "att-1",
    });
    expect([...meta.values()][0]).toMatchObject({ kind: "merge-intent", attemptId: "att-1" });
  });

  it("stores an empty envelope without pretending it is absent", async () => {
    const { impl } = bucket();
    const bytes = new Uint8Array(0);
    const d = await digest(bytes);
    expect(
      await putEvidence(impl, { organizationId: ORG, repositoryId: REPO, kind: KIND, digest: d, bytes }),
    ).toMatchObject({ stored: true });
    expect(await impl.head(evidenceKey({ organizationId: ORG, repositoryId: REPO, kind: KIND, digest: d }))).not.toBeNull();
  });
});
