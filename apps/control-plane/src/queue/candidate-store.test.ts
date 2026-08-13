import { afterEach, describe, expect, it } from "vitest";
import { seedActiveProject, testD1 } from "../../test/d1.js";
import {
  candidateDispatchBinding,
  candidateVerdict,
  claimCandidateDispatch as claimBoundCandidateDispatch,
  recordCandidateVerdict,
} from "./candidate-store.js";
import type { D1Like } from "./projection.js";
import type { CandidateVerdict } from "./store.js";

/**
 * Verdicts and dispatch claims live in D1 rather than in the Durable Object, so
 * candidate progress can be read without waking the coordination object. These
 * are the same properties the object enforced, checked where the data actually
 * is now.
 */

const open: Array<{ close(): void }> = [];

function d1(): D1Like {
  const t = testD1();
  seedActiveProject(t, { repositoryId: REPO });
  open.push(t);
  return t.db;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "4".repeat(40);
const PROJECT = `proj_${REPO}`;

function claimCandidateDispatch(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  projectId: string,
  candidateTreeOid: string,
  at: string,
  staleAfterMs: number,
) {
  return claimBoundCandidateDispatch(
    db,
    repositoryId,
    baseRef,
    projectId,
    "attempt_1",
    2,
    candidateTreeOid,
    at,
    staleAfterMs,
  );
}

function verdict(over: Partial<CandidateVerdict> = {}): CandidateVerdict {
  return {
    candidateTreeOid: TREE,
    candidateSha: "3".repeat(40),
    baseSha: "1".repeat(40),
    pullRequestNumber: 42,
    accepted: true,
    resultDigest: `sha256:${"a".repeat(64)}`,
    policyDigest: `sha256:${"b".repeat(64)}`,
    suites: [{ name: "test", outcome: "passed", durationMs: 693 }],
    reasonCodes: [],
    workflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
    workflowSha: "5".repeat(40),
    runId: "556677",
    observedAt: "2026-07-30T20:00:00Z",
    ...over,
  };
}

describe("candidate verdicts", () => {
  it("stores and reads back everything the merge gate checks", async () => {
    const db = d1();
    expect(await recordCandidateVerdict(db, REPO, REF, PROJECT, verdict())).toEqual({ status: "applied" });
    const read = await candidateVerdict(db, REPO, REF, TREE);
    expect(read).toEqual(verdict());
  });

  it("is nothing for a tree nobody judged", async () => {
    expect(await candidateVerdict(d1(), REPO, REF, TREE)).toBeNull();
  });

  it("keeps the first verdict, so a second run cannot overturn a refusal", async () => {
    const db = d1();
    await recordCandidateVerdict(db, REPO, REF, PROJECT, verdict({ accepted: false, reasonCodes: ["SUITE_NOT_PASSED"] }));
    expect(await recordCandidateVerdict(db, REPO, REF, PROJECT, verdict({ accepted: true }))).toEqual({
      status: "duplicate",
    });
    expect((await candidateVerdict(db, REPO, REF, TREE))?.accepted).toBe(false);
  });

  it("keeps repositories and branches apart", async () => {
    const db = d1();
    await recordCandidateVerdict(db, REPO, REF, PROJECT, verdict());
    expect(await candidateVerdict(db, "999", REF, TREE)).toBeNull();
    expect(await candidateVerdict(db, REPO, "refs/heads/release", TREE)).toBeNull();
  });

  it("rejects a delayed verdict from a released project incarnation", async () => {
    const t = testD1();
    open.push(t);
    seedActiveProject(t, { repositoryId: REPO, projectId: "project_old" });
    t.raw.prepare("DELETE FROM projects WHERE id = 'project_old'").run();
    seedActiveProject(t, { repositoryId: REPO, projectId: "project_new" });

    expect(await recordCandidateVerdict(t.db, REPO, REF, "project_old", verdict())).toEqual({
      status: "unavailable",
    });
    expect(await candidateVerdict(t.db, REPO, REF, TREE)).toBeNull();
  });
});

describe("claiming a candidate dispatch", () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 6, 30, 20, minutes, 0)).toISOString();
  const STALE = 15 * 60_000;

  it("lets the first caller dispatch", async () => {
    const db = d1();
    expect(await claimCandidateDispatch(db, REPO, REF, PROJECT, TREE, t(0), STALE)).toBe(true);
    await expect(candidateDispatchBinding(db, REPO, REF, TREE, PROJECT)).resolves.toEqual({
      projectId: PROJECT,
      attemptId: "attempt_1",
      workflowProtocol: 2,
    });
  });

  it("refuses a second caller while the first run may still be going", async () => {
    const db = d1();
    await claimCandidateDispatch(db, REPO, REF, PROJECT, TREE, t(0), STALE);
    for (const minute of [0, 1, 5, 14]) {
      expect(await claimCandidateDispatch(db, REPO, REF, PROJECT, TREE, t(minute), STALE), `minute ${minute}`).toBe(
        false,
      );
    }
  });

  it("dispatches again once the first attempt is old enough to have died", async () => {
    const db = d1();
    await claimCandidateDispatch(db, REPO, REF, PROJECT, TREE, t(0), STALE);
    expect(await claimCandidateDispatch(db, REPO, REF, PROJECT, TREE, t(15), STALE)).toBe(true);
    // and the clock restarts from the new claim
    expect(await claimCandidateDispatch(db, REPO, REF, PROJECT, TREE, t(16), STALE)).toBe(false);
  });

  it("treats a different candidate as its own claim", async () => {
    const db = d1();
    await claimCandidateDispatch(db, REPO, REF, PROJECT, TREE, t(0), STALE);
    expect(await claimCandidateDispatch(db, REPO, REF, PROJECT, "9".repeat(40), t(0), STALE)).toBe(true);
  });

  it("rejects a delayed dispatch claim from a released project incarnation", async () => {
    const tdb = testD1();
    open.push(tdb);
    seedActiveProject(tdb, { repositoryId: REPO, projectId: "project_old" });
    tdb.raw.prepare("DELETE FROM projects WHERE id = 'project_old'").run();
    seedActiveProject(tdb, { repositoryId: REPO, projectId: "project_new" });

    expect(await claimCandidateDispatch(tdb.db, REPO, REF, "project_old", TREE, t(0), STALE)).toBe(false);
    expect(tdb.raw.prepare("SELECT COUNT(*) AS count FROM candidate_dispatches").get()).toEqual({ count: 0 });
  });

  it("does not carry a protocol 1 dispatch binding across removal and reselection", async () => {
    const tdb = testD1();
    open.push(tdb);
    seedActiveProject(tdb, { repositoryId: REPO, projectId: "project_old" });
    await claimBoundCandidateDispatch(
      tdb.db,
      REPO,
      REF,
      "project_old",
      "attempt_old",
      1,
      TREE,
      t(0),
      STALE,
    );

    tdb.raw.prepare("DELETE FROM projects WHERE id = 'project_old'").run();
    seedActiveProject(tdb, { repositoryId: REPO, projectId: "project_new" });

    await expect(candidateDispatchBinding(tdb.db, REPO, REF, TREE, "project_old")).resolves.toBeNull();
    await expect(candidateDispatchBinding(tdb.db, REPO, REF, TREE, "project_new")).resolves.toBeNull();
  });
});
