import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import type { ChainLink } from "@thwip/queue-protocol";
import {
  baseAt,
  intactLinks,
  linksWithAGap,
  makeLink,
  treeAt,
} from "@thwip/queue-protocol/test/verify-chain-fixtures";
import { seedActiveProject, testD1, type TestD1 } from "../../test/d1.js";
import {
  CHAIN_SELF_CHECK_HEAD_LINKS,
  CHAIN_SELF_CHECK_ROTATION_LINKS,
  chainSelfCheckWindows,
  checkOwnChain,
  findingsForChainWindow,
} from "./chain-self-check.js";

describe("checkOwnChain", () => {
  it("reports a chain whose base jumps, because that is a merge nobody recorded", async () => {
    const findings = await checkOwnChain(linksWithAGap(), { epochStartsAt: 1, verifySignature: async () => true });
    expect(findings.map((f) => f.code)).toContain("BASE_DISCONTINUITY");
  });

  it("says nothing about a chain that joins up", async () => {
    const findings = await checkOwnChain(intactLinks(), { epochStartsAt: 1, verifySignature: async () => true });
    expect(findings).toEqual([]);
  });

  /**
   * An empty findings list means nothing when no signature was checked. The
   * verifier returns the count for exactly this reason and a caller that ignores
   * it reports a clean chain having read nothing.
   */
  it("treats a walk that verified no signatures as a finding of its own", async () => {
    const findings = await checkOwnChain(intactLinks(), { epochStartsAt: 9999, verifySignature: async () => true });
    expect(findings.map((f) => f.code)).toContain("NOTHING_CHECKED");
  });
});

describe("chainSelfCheckWindows", () => {
  it("verifies a chain small enough to check whole, whatever the slot", () => {
    expect(chainSelfCheckWindows(0, 0)).toEqual([]);
    expect(chainSelfCheckWindows(1, 9)).toEqual([{ offset: 0, limit: 1 }]);
    expect(chainSelfCheckWindows(CHAIN_SELF_CHECK_HEAD_LINKS + CHAIN_SELF_CHECK_ROTATION_LINKS, 3)).toEqual([
      { offset: 0, limit: CHAIN_SELF_CHECK_HEAD_LINKS + CHAIN_SELF_CHECK_ROTATION_LINKS },
    ]);
  });

  it("keeps the newest links in every window and advances the rotation one stride per tick", () => {
    // 60 links: 50 older than the head window, stride 15, so a cycle is 4 ticks.
    const count = 60;
    expect(chainSelfCheckWindows(count, 0)).toEqual([
      { offset: 50, limit: CHAIN_SELF_CHECK_HEAD_LINKS },
      { offset: 0, limit: CHAIN_SELF_CHECK_ROTATION_LINKS + 1 },
    ]);
    expect(chainSelfCheckWindows(count, 1)).toEqual([
      { offset: 50, limit: CHAIN_SELF_CHECK_HEAD_LINKS },
      { offset: 15, limit: CHAIN_SELF_CHECK_ROTATION_LINKS + 1 },
    ]);
    // The cycle wraps, and a negative slot (never produced by the clock, cheap
    // to be correct about) still lands inside it.
    expect(chainSelfCheckWindows(count, 4)).toEqual(chainSelfCheckWindows(count, 0));
    expect(chainSelfCheckWindows(count, -1)).toEqual(chainSelfCheckWindows(count, 3));
  });

  it("covers every link, and every adjacent pair, within one rotation cycle", () => {
    for (const count of [26, 30, 41, 100, 261]) {
      const older = count - CHAIN_SELF_CHECK_HEAD_LINKS;
      const cycle = Math.ceil(older / CHAIN_SELF_CHECK_ROTATION_LINKS);
      const covered = new Set<number>();
      const pairStarts = new Set<number>();
      for (let slot = 0; slot < cycle; slot++) {
        for (const window of chainSelfCheckWindows(count, slot)) {
          const inWindow: number[] = [];
          for (let index = window.offset; index < Math.min(window.offset + window.limit, count); index++) {
            covered.add(index);
            inWindow.push(index);
          }
          // A pair is checked when both links sit in one window together. The
          // stride-plus-one window is what guarantees this for every pair.
          for (let i = 0; i + 1 < inWindow.length; i++) pairStarts.add(inWindow[i]!);
        }
      }
      expect([...covered].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
      for (let start = 0; start + 1 < count; start++) {
        expect(pairStarts.has(start)).toBe(true);
      }
    }
  });

  it("bounds what one tick verifies, whatever the chain has grown to", () => {
    for (const count of [26, 60, 100, 1000]) {
      const total = chainSelfCheckWindows(count, 3).reduce((sum, window) => sum + window.limit, 0);
      expect(total).toBeLessThanOrEqual(CHAIN_SELF_CHECK_HEAD_LINKS + CHAIN_SELF_CHECK_ROTATION_LINKS + 1);
    }
  });
});

describe("findingsForChainWindow", () => {
  /** The base a `gapAt` link begins at: a sha no link in the fixture chain reaches. */
  const UNREACHED_BASE = "e".repeat(40);
  const REPO = "1315419165";
  const REF = "refs/heads/main";
  const open: Array<{ close(): void }> = [];
  let signingKey: CryptoKey;
  let publicJwk: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    signingKey = pair.privateKey;
    publicJwk = JSON.stringify({ ...(await exportJWK(pair.publicKey)), kid: "window-test", alg: "ES256" });
  });

  afterEach(() => {
    while (open.length > 0) open.pop()!.close();
  });

  async function db(): Promise<{ t: TestD1; projectId: string }> {
    const t = testD1();
    open.push(t);
    t.raw.prepare("INSERT INTO service_keys (kid, public_jwk) VALUES (?, ?)").run("window-test", publicJwk);
    // Attestation inserts are silently dropped (RAISE(IGNORE)) without a live
    // project incarnation for the repository, so the chain needs one.
    const projectId = seedActiveProject(t, { repositoryId: REPO });
    return { t, projectId };
  }

  /** A chain of real, signed links, optionally with one defect. */
  async function signedLinks(
    count: number,
    defect: { readonly tamper?: number; readonly gapAt?: number } = {},
  ): Promise<ChainLink[]> {
    const links: ChainLink[] = [];
    let previous: string | null = null;
    for (let sequence = 1; sequence <= count; sequence++) {
      // `gapAt` begins at a base no link reaches: the shape an unrecorded merge
      // leaves, and the one finding the head window exists to catch quickly.
      const before = defect.gapAt === sequence ? UNREACHED_BASE : undefined;
      const built = await makeLink({
        sequence,
        previous,
        ...(before === undefined ? {} : { before }),
      });
      links.push({
        digest: built.digest,
        sequence,
        bytes: built.bytes,
        jws: await new CompactSign(built.bytes).setProtectedHeader({ alg: "ES256", kid: "window-test" }).sign(signingKey),
      });
      previous = built.digest;
    }
    if (defect.tamper !== undefined) {
      const index = defect.tamper - 1;
      links[index] = { ...links[index]!, jws: "not-a-signature" };
    }
    return links;
  }

  function insert(t: TestD1, projectId: string, links: readonly ChainLink[]): void {
    const statement = t.raw.prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, project_id, base_ref, transition_sequence, attempt_id, bytes, jws)
       VALUES (?, 'reused-proof-merge', ?, ?, ?, ?, NULL, ?, ?)`,
    );
    for (const link of links) {
      statement.run(
        link.digest,
        REPO,
        projectId,
        REF,
        link.sequence ?? null,
        new TextDecoder().decode(link.bytes),
        link.jws,
      );
    }
  }

  function check(t: TestD1, epochStartsAt: number, slot: number) {
    return findingsForChainWindow(t.db, { repositoryId: REPO, baseRef: REF, epochStartsAt, slot });
  }

  it("verifies a small chain whole, whatever the slot", async () => {
    const { t, projectId } = await db();
    insert(t, projectId, await signedLinks(20, { tamper: 7 }));
    for (const slot of [0, 1, 5]) {
      const findings = await check(t, 1, slot);
      expect(findings.map((f) => f.code)).toContain("BAD_SIGNATURE");
    }
  });

  it("checks the newest links on every tick", async () => {
    const { t, projectId } = await db();
    insert(t, projectId, await signedLinks(40, { tamper: 40 }));
    for (const slot of [0, 1, 2, 3]) {
      const findings = await check(t, 1, slot);
      expect(findings.map((f) => f.code)).toContain("BAD_SIGNATURE");
    }
  });

  it("reaches a tampered old link only when the rotation window covers it", async () => {
    const { t, projectId } = await db();
    insert(t, projectId, await signedLinks(40, { tamper: 5 }));
    // 40 links: older region is 30, stride 15, cycle 2. Slot 0's rotation
    // window is [0, 16) and covers link 5; slot 1's is [15, 31) and does not.
    const covered = await check(t, 1, 0);
    expect(covered.map((f) => f.code)).toContain("BAD_SIGNATURE");
    const notCovered = await check(t, 1, 1);
    expect(notCovered).toEqual([]);
  });

  it("reports a base discontinuity inside the rotation window", async () => {
    const { t, projectId } = await db();
    insert(t, projectId, await signedLinks(40, { gapAt: 20 }));
    // Slot 1's rotation window [15, 31) holds both sides of the gap at link 20;
    // slot 0's [0, 16) stops before it, and the head window starts past it.
    const covered = await check(t, 1, 1);
    expect(covered.map((f) => f.code)).toContain("BASE_DISCONTINUITY");
    const elsewhere = await check(t, 1, 0);
    expect(elsewhere).toEqual([]);
  });

  it("falls back to the full walk when a served correction's target is not co-served", async () => {
    const { t, projectId } = await db();
    // Link 4 begins at UNREACHED_BASE — the move the correction says link 3
    // should have named — and link 30 corrects link 3. The correction sits in
    // the head window while its target sits deep, and link 5 carries a bad
    // signature that only a full walk reaches at this slot.
    const links = await signedLinks(30, { tamper: 5, gapAt: 4 });
    const target = links[2]!;
    const correction = await correctionLink({
      sequence: 30,
      previous: links[28]!.digest,
      corrects: { digest: target.digest, sequence: 3 },
      correctedBaseSha: baseAt(3),
      after: UNREACHED_BASE,
    });
    insert(t, projectId, [...links.slice(0, 29), correction]);

    // Slot 1: rotation [15, 31) holds neither link 5 nor the target, so every
    // finding below can only come from the fallback.
    const findings = await check(t, 1, 1);
    expect(findings.map((f) => f.code)).toContain("BAD_SIGNATURE");
    expect(findings.map((f) => f.code)).not.toContain("CORRECTION_UNANCHORED");
    expect(findings.map((f) => f.code)).not.toContain("BASE_DISCONTINUITY");
  });

  it("keeps the NOTHING_CHECKED verdict for a range that starts past every record", async () => {
    const { t, projectId } = await db();
    insert(t, projectId, await signedLinks(3));
    const findings = await check(t, 999, 0);
    expect(findings.map((f) => f.code)).toContain("NOTHING_CHECKED");
  });

  /**
   * A base-correction record in the fixture builders' shape: a signed restatement
   * of an earlier record's move with the sha the branch actually took.
   */
  async function correctionLink(input: {
    readonly sequence: number;
    readonly previous: string;
    readonly corrects: { readonly digest: string; readonly sequence: number };
    readonly correctedBaseSha: string;
    readonly after: string;
  }): Promise<ChainLink> {
    const { canonicalBytes, envelopeDigest } = await import("@thwip/queue-protocol");
    const record = {
      schemaVersion: "1",
      kind: "base-correction",
      repositoryId: REPO,
      baseRef: REF,
      queueEpoch: 1,
      transitionSequence: input.sequence,
      previousTransitionDigest: input.previous,
      before: { baseSha: baseAt(input.corrects.sequence - 1), treeOid: treeAt(input.corrects.sequence - 1) },
      after: {
        baseSha: input.after,
        treeOid: treeAt(input.corrects.sequence),
        parentOids: [baseAt(input.corrects.sequence - 1), "2".repeat(40)],
        parentCount: 2,
        parentOidsDigest: `sha256:${"7".repeat(64)}`,
        parentsComplete: true,
      },
      observedAt: "2026-08-19T00:00:00Z",
      correction: {
        correctsTransitionDigest: input.corrects.digest,
        correctsTransitionSequence: input.corrects.sequence,
        correctedBaseSha: input.correctedBaseSha,
        attemptId: `att-${input.corrects.sequence}`,
        actorPrincipalId: "prn_correction",
        reason: "the recorded base was wrong",
      },
    };
    const bytes = canonicalBytes(JSON.stringify(record));
    return {
      digest: await envelopeDigest(bytes),
      sequence: input.sequence,
      bytes,
      jws: await new CompactSign(bytes).setProtectedHeader({ alg: "ES256", kid: "window-test" }).sign(signingKey),
    };
  }
});
