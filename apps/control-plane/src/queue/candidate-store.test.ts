import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { candidateVerdict, claimCandidateDispatch, recordCandidateVerdict } from "./candidate-store.js";
import type { D1Like } from "./projection.js";
import type { CandidateVerdict } from "./store.js";

/**
 * Verdicts and dispatch claims live in D1 rather than in the Durable Object, so
 * the merge workflow can wait for a candidate without waking the coordination
 * object. These are the same properties the object enforced, checked where the
 * data actually is now.
 */

const open: Array<{ close(): void }> = [];

function d1(): D1Like {
  const db = new Database(":memory:");
  open.push(db);
  // From the migrations, not restated here: a second copy of the schema drifts
  // and then the tests describe a table that no longer exists.
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations");
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    for (const statement of readFileSync(join(dir, file), "utf8").split(";")) {
      const sql = statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (sql.length === 0) continue;
      try {
        db.exec(sql);
      } catch (error) {
        if (/candidate_verdicts|candidate_dispatches/.test(sql)) throw error;
      }
    }
  }

  const prepare = (query: string) => ({
    bind: (...values: unknown[]) => ({
      async run() {
        db.prepare(query).run(...(values as never[]));
      },
      async first<T>() {
        return (db.prepare(query).get(...(values as never[])) ?? null) as T | null;
      },
      async all<T>() {
        return { results: db.prepare(query).all(...(values as never[])) as T[] };
      },
    }),
  });
  return {
    prepare,
    async batch(statements: unknown[]) {
      for (const s of statements) await (s as { run(): Promise<unknown> }).run();
    },
  } as unknown as D1Like;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "4".repeat(40);

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
    expect(await recordCandidateVerdict(db, REPO, REF, verdict())).toEqual({ status: "applied" });
    const read = await candidateVerdict(db, REPO, REF, TREE);
    expect(read).toEqual(verdict());
  });

  it("is nothing for a tree nobody judged", async () => {
    expect(await candidateVerdict(d1(), REPO, REF, TREE)).toBeNull();
  });

  it("keeps the first verdict, so a second run cannot overturn a refusal", async () => {
    const db = d1();
    await recordCandidateVerdict(db, REPO, REF, verdict({ accepted: false, reasonCodes: ["SUITE_NOT_PASSED"] }));
    expect(await recordCandidateVerdict(db, REPO, REF, verdict({ accepted: true }))).toEqual({
      status: "duplicate",
    });
    expect((await candidateVerdict(db, REPO, REF, TREE))?.accepted).toBe(false);
  });

  it("keeps repositories and branches apart", async () => {
    const db = d1();
    await recordCandidateVerdict(db, REPO, REF, verdict());
    expect(await candidateVerdict(db, "999", REF, TREE)).toBeNull();
    expect(await candidateVerdict(db, REPO, "refs/heads/release", TREE)).toBeNull();
  });
});

describe("claiming a candidate dispatch", () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 6, 30, 20, minutes, 0)).toISOString();
  const STALE = 15 * 60_000;

  it("lets the first caller dispatch", async () => {
    expect(await claimCandidateDispatch(d1(), REPO, REF, TREE, t(0), STALE)).toBe(true);
  });

  it("refuses a second caller while the first run may still be going", async () => {
    const db = d1();
    await claimCandidateDispatch(db, REPO, REF, TREE, t(0), STALE);
    for (const minute of [0, 1, 5, 14]) {
      expect(await claimCandidateDispatch(db, REPO, REF, TREE, t(minute), STALE), `minute ${minute}`).toBe(
        false,
      );
    }
  });

  it("dispatches again once the first attempt is old enough to have died", async () => {
    const db = d1();
    await claimCandidateDispatch(db, REPO, REF, TREE, t(0), STALE);
    expect(await claimCandidateDispatch(db, REPO, REF, TREE, t(15), STALE)).toBe(true);
    // and the clock restarts from the new claim
    expect(await claimCandidateDispatch(db, REPO, REF, TREE, t(16), STALE)).toBe(false);
  });

  it("treats a different candidate as its own claim", async () => {
    const db = d1();
    await claimCandidateDispatch(db, REPO, REF, TREE, t(0), STALE);
    expect(await claimCandidateDispatch(db, REPO, REF, "9".repeat(40), t(0), STALE)).toBe(true);
  });
});
