import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cmdVerifyChain,
  exitForStatus,
  parseChainResponse,
  parseKeySet,
  resolveRepositoryIdFromGithub,
  summarize,
  verifyPublishedChain,
  type ChainResponse,
} from "./verify-chain.js";
import { EXIT } from "./queue-exit.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * What a person sees. A verifier that prints "3 findings" tells them nothing
 * about whether to trust the branch, so the summary leads with the answer and
 * separates history from failure.
 */
describe("the verification summary", () => {
  it("says a clean chain holds", () => {
    expect(summarize(42, [])).toContain("42 links verified");
  });

  it("separates pre-attestation history from real problems", () => {
    const text = summarize(3, [
      { code: "PRE_ATTESTATION", sequence: null, digest: "sha256:a", detail: "written before signed records" },
    ]);
    expect(text).toContain("1 link predates signed records");
    expect(text).not.toMatch(/fail/i);
  });

  it("names a broken link and fails", () => {
    const text = summarize(2, [
      { code: "BROKEN_LINK", sequence: 7, digest: "sha256:b", detail: "names the wrong predecessor" },
    ]);
    expect(text).toMatch(/BROKEN_LINK/);
    expect(text).toMatch(/link 7/);
  });

  it("reports a gap as a merge that landed without a record", () => {
    const text = summarize(2, [
      { code: "SEQUENCE_GAP", sequence: 48, digest: "sha256:c", detail: "a merge landed without a record" },
    ]);
    expect(text).toContain("landed without a record");
  });
});

/**
 * The wire link carries `sequence`, and it is what distinguishes a record that
 * has gone missing from history predating signed records. Dropping it on the
 * way into `verifyChain` would silently turn every gap into harmless history.
 */
describe("verifyPublishedChain", () => {
  it("reports an empty link within the attested range as a missing record", async () => {
    const chain: ChainResponse = {
      epochStartsAt: 42,
      links: [{ digest: "sha256:a", sequence: 47, record: "", jws: "" }],
    };
    const { findings } = await verifyPublishedChain(chain, { keys: [] });
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("MISSING_RECORD");
    expect(codes).not.toContain("PRE_ATTESTATION");
  });

  it("reports an empty link before the epoch as pre-attestation history", async () => {
    const chain: ChainResponse = {
      epochStartsAt: 42,
      links: [{ digest: "sha256:a", sequence: 3, record: "", jws: "" }],
    };
    const { findings } = await verifyPublishedChain(chain, { keys: [] });
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("PRE_ATTESTATION");
    expect(codes).not.toContain("MISSING_RECORD");
  });
});

/**
 * A 4xx means the request itself is wrong and retrying changes nothing; a 429
 * is a rate limit; a 5xx is the transient class. Each has its own exit code so
 * a caller (human or agent) can tell them apart without parsing text.
 */
describe("exitForStatus", () => {
  it("maps not-found and bad-request to setupInvalid", () => {
    expect(exitForStatus(404)).toBe(EXIT.setupInvalid);
    expect(exitForStatus(400)).toBe(EXIT.setupInvalid);
  });

  it("maps 429 to rateLimited", () => {
    expect(exitForStatus(429)).toBe(EXIT.rateLimited);
  });

  it("maps server errors to unavailable", () => {
    expect(exitForStatus(500)).toBe(EXIT.unavailable);
    expect(exitForStatus(503)).toBe(EXIT.unavailable);
  });
});

/**
 * This lookup is what lets `thwip verify-chain` work without a thwip account:
 * it goes straight to GitHub's public API, unauthenticated. Sending a
 * credential here would defeat the point of the command.
 */
describe("resolveRepositoryIdFromGithub", () => {
  it("resolves an id and sends no authorization header", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 1315419165 }));
    vi.stubGlobal("fetch", fetchMock);

    const id = await resolveRepositoryIdFromGithub("recallnet/thwip");

    expect(id).toBe("1315419165");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/recallnet/thwip");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has("authorization")).toBe(false);
  });

  it("fails the way the caller expects when GitHub does not know the repo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    const id = await resolveRepositoryIdFromGithub("recallnet/does-not-exist");

    expect(id).toBeNull();
  });
});

/**
 * A network failure while fetching the chain must not throw out of the
 * command — it is a transient condition the caller can retry, not a bug.
 */
describe("cmdVerifyChain network failure", () => {
  it("returns the unavailable exit code instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network down"))));

    const code = await cmdVerifyChain(["--repository-id", "123"]);

    expect(code).toBe(EXIT.unavailable);
  });
});

/**
 * A keys outage must never be reported as a forged chain. Every signature
 * would fail against no keys at all, which reads exactly like a forged chain
 * unless the outage is caught first.
 */
describe("cmdVerifyChain keys outage", () => {
  it("exits unavailable and prints no signature verdict when the keys endpoint fails", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("thwip-keys")) return new Response("boom", { status: 503 });
        return Response.json({ epochStartsAt: 1, links: [] });
      }),
    );

    const code = await cmdVerifyChain(["--repository-id", "123"]);

    expect(code).toBe(EXIT.unavailable);
    expect(writes.join("")).not.toMatch(/BAD_SIGNATURE/);
    vi.restoreAllMocks();
  });

  it("exits unavailable when the key set is present but empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("thwip-keys")) return Response.json({ keys: [] });
        return Response.json({ epochStartsAt: 1, links: [] });
      }),
    );

    const code = await cmdVerifyChain(["--repository-id", "123"]);

    expect(code).toBe(EXIT.unavailable);
  });
});

/**
 * The response is validated, not cast. A malformed body must exit with a code
 * rather than crash on `.links.map`.
 */
describe("cmdVerifyChain malformed chain response", () => {
  it("exits unavailable instead of throwing on a junk body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("thwip-keys")) {
          return Response.json({ keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k1" }] });
        }
        return Response.json({ not: "a chain" });
      }),
    );

    const code = await cmdVerifyChain(["--repository-id", "123"]);

    expect(code).toBe(EXIT.unavailable);
  });
});

describe("parseChainResponse", () => {
  it("rejects a body missing the shape it needs", () => {
    expect(parseChainResponse(null)).toBeNull();
    expect(parseChainResponse({})).toBeNull();
    expect(parseChainResponse({ epochStartsAt: 1, links: "nope" })).toBeNull();
    expect(parseChainResponse({ epochStartsAt: 1, links: [{ digest: "d" }] })).toBeNull();
  });

  it("accepts a well-shaped body", () => {
    const body = { epochStartsAt: 1, links: [{ digest: "d", record: "{}", jws: "j", sequence: 1 }] };
    expect(parseChainResponse(body)).toEqual(body);
  });
});

describe("parseKeySet", () => {
  it("rejects a missing or empty key array", () => {
    expect(parseKeySet(null)).toBeNull();
    expect(parseKeySet({})).toBeNull();
    expect(parseKeySet({ keys: [] })).toBeNull();
  });

  it("accepts a non-empty key array", () => {
    const body = { keys: [{ kty: "EC" }] };
    expect(parseKeySet(body)).toEqual(body);
  });
});

/**
 * A server that claims signature checking starts far in the future would make
 * the verifier skip every check and print a clean "N links verified" for a
 * chain with no valid signature at all. `--epoch` exists so a caller does not
 * have to trust that claim.
 */
describe("cmdVerifyChain --epoch pinning", () => {
  it("still reports BAD_SIGNATURE when the server claims a huge epochStartsAt", async () => {
    const record = {
      schemaVersion: "1",
      kind: "reused-proof-merge",
      repositoryId: "123",
      baseRef: "refs/heads/main",
      queueEpoch: 1,
      transitionSequence: 1,
      previousTransitionDigest: null,
      before: { baseSha: null, treeOid: null },
      after: {
        baseSha: "3".repeat(40),
        treeOid: "4".repeat(40),
        parentOids: ["3".repeat(40)],
        parentCount: 1,
        parentOidsDigest: `sha256:${"7".repeat(64)}`,
        parentsComplete: true,
      },
      observedAt: "2026-07-31T12:00:00Z",
      reusedProof: {
        attemptId: "att-1",
        mergeIntentDigest: `sha256:${"1".repeat(64)}`,
        pullRequestNumber: 1,
        headSha: "2".repeat(40),
        candidateSha: "3".repeat(40),
        candidateTreeOid: "4".repeat(40),
        mergeMethod: "squash",
        workReceiptDigest: `sha256:${"2".repeat(64)}`,
        policyDigest: `sha256:${"6".repeat(64)}`,
        pipelineDigest: `sha256:${"8".repeat(64)}`,
        requiredSuitesDigest: `sha256:${"9".repeat(64)}`,
        checkRunId: "778899",
      },
    };
    const { canonicalBytes, envelopeDigest } = await import("@thwip/queue-protocol");
    const bytes = canonicalBytes(JSON.stringify(record));
    const digest = await envelopeDigest(bytes);

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("thwip-keys")) {
          return Response.json({ keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k1" }] });
        }
        // A server claiming the epoch starts absurdly far in the future would
        // make an unpinned verifier skip this link's signature check entirely.
        return Response.json({
          epochStartsAt: 999_999_999,
          links: [{ digest, record: new TextDecoder().decode(bytes), jws: "not-a-real-signature", sequence: 1 }],
        });
      }),
    );

    const code = await cmdVerifyChain(["--repository-id", "123", "--epoch", "1"]);

    expect(code).toBe(EXIT.evidenceRejected);
    expect(writes.join("")).toMatch(/BAD_SIGNATURE/);
    expect(writes.join("")).toMatch(/epoch: 1 \(pinned\)/);
    vi.restoreAllMocks();
  });
});
