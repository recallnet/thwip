import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cmdVerifyChain,
  evaluateDeployEvidence,
  exitForStatus,
  parseChainResponse,
  parseKeySet,
  resolveRepositoryIdFromGithub,
  summarize,
  verifyPublishedChain,
  type ChainResponse,
} from "./verify-chain.js";
import type { ChainFinding } from "@thwip/queue-protocol";
import { EXIT } from "./queue-exit.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const DEPLOY_SHA = "a".repeat(40);
const deployRecord = (kind: string = "reused-proof-merge", sequence = 228) => ({
  digest: `sha256:${"d".repeat(64)}`,
  sequence,
  record: {
    kind,
    after: { baseSha: DEPLOY_SHA },
    ...(kind === "verified-merge"
      ? { verifiedMerge: { pullRequestNumber: 341 } }
      : kind === "reused-proof-merge"
        ? { reusedProof: { pullRequestNumber: 341 } }
        : kind === "candidate-verified-merge"
          ? { candidateVerified: { pullRequestNumber: 341 } }
          : { override: { pullRequestNumber: 341 } }),
  },
});

describe("deploy evidence from the chain verifier", () => {
  it.each(["verified-merge", "reused-proof-merge", "candidate-verified-merge"])(
    "accepts one signed %s record for the exact SHA",
    (kind) => {
      expect(evaluateDeployEvidence({
        findings: [],
        signaturesChecked: 60,
        records: [deployRecord(kind) as never],
        epochStartsAt: 169,
      }, DEPLOY_SHA)).toMatchObject({ ok: true, evidence: { kind, pullRequestNumber: 341 } });
    },
  );

  it("refuses overrides, unsigned results, and records outside the signed range", () => {
    expect(evaluateDeployEvidence({
      findings: [], signaturesChecked: 60, records: [deployRecord("override-merge") as never], epochStartsAt: 169,
    }, DEPLOY_SHA)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a verified merge/) });
    expect(evaluateDeployEvidence({
      findings: [], signaturesChecked: 0, records: [deployRecord() as never], epochStartsAt: 169,
    }, DEPLOY_SHA)).toMatchObject({ ok: false, reason: expect.stringMatching(/no signatures/) });
    expect(evaluateDeployEvidence({
      findings: [], signaturesChecked: 60, records: [deployRecord() as never], epochStartsAt: 229,
    }, DEPLOY_SHA)).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the signed range/) });
  });
});

/**
 * What a person sees. A verifier that prints "3 findings" tells them nothing
 * about whether to trust the branch, so the summary leads with the answer and
 * separates history from failure.
 */
describe("the verification summary", () => {
  it("says a clean chain holds", () => {
    expect(summarize(42, 42, [])).toContain("42 links verified");
  });

  /**
   * A chain that verifies because a record was corrected is not a chain that
   * never got anything wrong. Both print the clean first line, so the second
   * line is the only thing that keeps them apart, and it is printed on the
   * clean run rather than filed as a problem: a correction is the chain
   * accounting for a mistake, not another mistake.
   */
  it("says a clean chain holds and still says a record was corrected", () => {
    const text = summarize(
      61,
      61,
      [],
      [
        {
          sequence: 61,
          digest: "sha256:e",
          correctsSequence: 54,
          correctsDigest: "sha256:f919eeab",
          from: "ff6ea882feefd64c4e9f4dff909209e7adb281e3",
          to: "0b2076107aa20f8b365d3b510de4838b05d12622",
          observedAt: "2026-08-02T09:00:00.000Z",
          actorPrincipalId: "prn_amelia",
          reason: "record 54 names the test merge for pull request 107",
        },
      ],
    );
    expect(text).toContain("61 links verified");
    expect(text).toContain("1 record was corrected");
    expect(text).toContain("link 61 corrects link 54");
    expect(text).toContain("0b2076107aa20f8b365d3b510de4838b05d12622");
    expect(text).toContain("ff6ea882feefd64c4e9f4dff909209e7adb281e3");
  });

  it("separates pre-attestation history from real problems", () => {
    const text = summarize(3, 2, [
      { code: "PRE_ATTESTATION", sequence: null, digest: "sha256:a", detail: "written before signed records" },
    ]);
    expect(text).toContain("1 link predates signed records");
    expect(text).not.toMatch(/fail/i);
  });

  it("names a broken link and fails", () => {
    const text = summarize(2, 2, [
      { code: "BROKEN_LINK", sequence: 7, digest: "sha256:b", detail: "names the wrong predecessor" },
    ]);
    expect(text).toMatch(/BROKEN_LINK/);
    expect(text).toMatch(/link 7/);
  });

  it("reports a gap as records that were written and not served", () => {
    const text = summarize(2, 2, [
      {
        code: "SEQUENCE_GAP",
        sequence: 48,
        digest: "sha256:c",
        detail: "link 48 follows 46; the records in between were written and not served",
      },
    ]);
    expect(text).toContain("the records in between were written and not served");
  });

  it("names a base that moved with no record and fails", () => {
    const text = summarize(2, 2, [
      {
        code: "BASE_DISCONTINUITY",
        sequence: 53,
        digest: "sha256:d",
        detail: "begins at a1fe3e7, but the record before it left the base at 7059839",
      },
    ]);
    expect(text).toMatch(/BASE_DISCONTINUITY/);
    expect(text).toMatch(/link 53/);
  });

  /**
   * The bug this closes: a chain where `epochStartsAt` skipped every
   * signature check produced zero findings and a bare "N links verified" —
   * indistinguishable from a chain that was actually checked.
   */
  /**
   * The arithmetic hole: history links were subtracted from the expected
   * count, so a response where every link predates signed records reached
   * "0 of 0 checked" and printed the clean line. Nothing was established, and
   * the summary has to say so.
   */
  it("does not call a chain of nothing but history verified", () => {
    const history: ChainFinding = {
      code: "PRE_ATTESTATION",
      sequence: null,
      digest: "sha256:a",
      detail: "before signed records",
    };
    const text = summarize(3, 0, [history, history, history]);
    expect(text).not.toMatch(/links verified/);
    expect(text).toContain("nothing was verified");
  });

  it("never prints a bare 'links verified' when fewer signatures were checked than links", () => {
    const text = summarize(42, 0, []);
    expect(text).not.toMatch(/^42 links verified\.?$/m);
    expect(text).toContain("42 links");
    expect(text).toContain("0 of 42 signatures checked");
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

  /**
   * A key set that parses as JSON but is not usable (junk `keys` entries with
   * none of the members their `kty` needs) is the same "nothing to check
   * against" fact as an empty key set, one step narrower. Before this, it made
   * `compactVerify` throw on every link, and the catch in `verifySignature`
   * reported every one of them `BAD_SIGNATURE` — the same false accusation
   * the empty/outage case exists to prevent.
   */
  it("exits unavailable, not BAD_SIGNATURE, when the key set parses but is not usable", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("thwip-keys")) return Response.json({ keys: [{ kty: "EC" }] });
        return Response.json({
          epochStartsAt: 1,
          links: [{ digest: "sha256:a", sequence: 1, record: "{}", jws: "not-a-real-signature" }],
        });
      }),
    );

    const code = await cmdVerifyChain(["--repository-id", "123"]);

    expect(code).toBe(EXIT.unavailable);
    expect(writes.join("")).not.toMatch(/BAD_SIGNATURE/);
    vi.restoreAllMocks();
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

  it("accepts a key array with a usable key", () => {
    const body = { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k1" }] };
    expect(parseKeySet(body)).toEqual(body);
  });

  /**
   * `{kty:"EC"}` alone parses as JSON and passes a shape check that only asks
   * "is this a non-empty array", but it has none of the members `compactVerify`
   * needs to actually verify anything. Left unchecked, this reads exactly like
   * a keys outage — but one step narrower, because the fetch itself succeeded.
   */
  it("rejects a key set whose keys are present but not usable", () => {
    expect(parseKeySet({ keys: [{ kty: "EC" }] })).toBeNull();
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

/**
 * The residual: with no `--epoch` given, the server's `epochStartsAt` is
 * still trusted. A server claiming it starts absurdly far in the future makes
 * every readable link skip its signature check, and — because no finding
 * fires for a skip — the run must still not print anything a reader would
 * take for a clean pass. The `epoch:` line above the summary is the only
 * other clue, and it must not contradict a summary claiming success.
 */
describe("cmdVerifyChain with no --epoch, server claims a huge epochStartsAt", () => {
  it("does not print output a reader would take as a clean verification", async () => {
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
        return Response.json({
          epochStartsAt: 999_999_999,
          links: [{ digest, record: new TextDecoder().decode(bytes), jws: "not-a-real-signature", sequence: 1 }],
        });
      }),
    );

    const code = await cmdVerifyChain(["--repository-id", "123"]);
    const output = writes.join("");

    // The bug this closes: no --epoch means the huge server value is trusted,
    // the link's signature is never checked, no finding fires, and the exit
    // code read as success. A CI gate scripted on the exit status passed a
    // chain nobody had checked a single signature of.
    expect(code).not.toBe(EXIT.ok);
    expect(code).toBe(EXIT.evidenceRejected);
    // What must not happen: a bare "1 links verified." that a reader would
    // take as "the signature checked out."
    expect(output).not.toMatch(/^1 links verified\.?$/m);
    expect(output).toMatch(/0 of 1 signatures checked/);
    vi.restoreAllMocks();
  });
});

/**
 * A chain whose links are all empty records used to arrive at "0 of 0
 * signatures checked", which the summary read as a clean pass and the exit
 * code reported as success. A server returning a high epoch and no records at
 * all could therefore be scripted against as if it had proved something.
 */
describe("cmdVerifyChain when every link is an empty record", () => {
  it("says nothing was verified and exits non-zero", async () => {
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
        return Response.json({
          epochStartsAt: 999_999_999,
          links: [
            { digest: "sha256:a", sequence: 1, record: "", jws: "" },
            { digest: "sha256:b", sequence: 2, record: "", jws: "" },
            { digest: "sha256:c", sequence: 3, record: "", jws: "" },
          ],
        });
      }),
    );

    const code = await cmdVerifyChain(["--repository-id", "123"]);
    const output = writes.join("");

    expect(code).not.toBe(EXIT.ok);
    expect(output).not.toMatch(/links verified/);
    expect(output).toMatch(/nothing was verified/);
    vi.restoreAllMocks();
  });
});

/**
 * The last unrecorded merge is the one the records cannot catch. A record is
 * written after the merge it describes, so a crash in between leaves a chain
 * that ends one merge short and is internally perfect. GitHub is asked where
 * the branch stands, because thwip cannot be: a service asked to report the
 * head it is behind would report a head that matches.
 */
describe("cmdVerifyChain against the branch head", () => {
  const LAST_RECORDED = "3".repeat(40);
  const BRANCH_HEAD = "a1fe3e7e32aed7eaeefe799174d5c4962331ac40";

  async function servedChain() {
    const record = {
      schemaVersion: "1",
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      queueEpoch: 1,
      transitionSequence: 1,
      previousTransitionDigest: null,
      before: { baseSha: null, treeOid: null },
      after: {
        baseSha: LAST_RECORDED,
        treeOid: "4".repeat(40),
        parentOids: [LAST_RECORDED],
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
        candidateSha: LAST_RECORDED,
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
    return {
      epochStartsAt: 1,
      links: [
        { digest: await envelopeDigest(bytes), record: new TextDecoder().decode(bytes), jws: "not-a-real-signature", sequence: 1 },
      ],
    };
  }

  function stub(chain: unknown, branchHead: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/branches/")) return Response.json({ commit: { sha: branchHead } });
        if (u.includes("api.github.com/repos/")) return Response.json({ id: 1315419165 });
        if (u.includes("thwip-keys")) {
          return Response.json({ keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k1" }] });
        }
        return Response.json(chain);
      }),
    );
  }

  it("reports a chain that ends before the branch does", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    stub(await servedChain(), BRANCH_HEAD);

    const code = await cmdVerifyChain(["--repo", "recallnet/thwip"]);
    const output = writes.join("");

    expect(code).toBe(EXIT.evidenceRejected);
    expect(output).toMatch(/CHAIN_BEHIND_HEAD/);
    expect(output).toContain(BRANCH_HEAD);
    vi.restoreAllMocks();
  });

  it("says so when the head could not be read, instead of implying it was checked", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    stub(await servedChain(), BRANCH_HEAD);

    await cmdVerifyChain(["--repository-id", "1315419165"]);
    const output = writes.join("");

    expect(output).toMatch(/head: not checked/);
    expect(output).not.toMatch(/CHAIN_BEHIND_HEAD/);
    vi.restoreAllMocks();
  });
});
