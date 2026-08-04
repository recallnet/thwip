# Merge Operation Obligation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the queue settle every merge write it starts, so a merge can never land without a chain record again, then repair the four merges that already did and publish the research note that documents all of it.

**Architecture:** The obligation to settle a merge write moves from the attempt to the write itself. A scheduled sweep finds writes nobody resolved, asks git what became of them, and records or refuses accordingly, reusing one shared implementation of "put a merge back in the chain" that the manual repair route already contains. A second scheduled job runs the existing chain verifier against the queue's own chain so a gap is reported rather than discovered.

**Tech Stack:** TypeScript on Cloudflare Workers, Durable Objects, D1, vitest, Hono routes, `@thwip/queue-protocol`.

---

## Background the engineer needs

On 2 August 2026 four pull requests merged into `recallnet/thwip` with no chain record: #117 (`812d3a8`), #119 (`33db87a`), #114 (`74add77`), #121 (`4c7b9c7`).

The sequence, confirmed from workflow logs and D1:

1. The merge workflow calls the control plane to authorize. It gets HTTP 200 and an `operationId`. The control plane inserts a `merge_operations` row with `outcome` and `resolved_at` both null.
2. The workflow calls GitHub's merge API. GitHub answers **405**, which it does transiently while it is still computing mergeability.
3. The workflow prints `leaving it to reconciliation` and exits 1.
4. The merge lands anyway.
5. The attempt is later terminated and compacted out of `state.attempts`.
6. Nothing ever looks at the `merge_operations` row again.

The row is only ever resolved by `confirmMerged` or `confirmNotMerged`, and both run only when the workflow calls back. The existing overdue sweep (`overdueReconciliation`, `settleReconciliation`) keys off a **surviving attempt**. Once the attempt is gone the write is orphaned. All four rows still read `outcome: null, resolved_at: null`, and the queue holds zero deadlines.

Verify the current damage at any time with:

```bash
node scripts/verify-chain.mjs 1315419165
```

That script exists on `main` (not in this worktree) and reports three `BASE_DISCONTINUITY` findings covering the four merges.

**Design principle for this plan:** the control plane must never learn the outcome of its own operation from the client that performed it. The workflow callback is a fast path. Git facts are the authority.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/control-plane/src/queue/record-from-intent.ts` (create) | The one implementation of "build, sign and record a transition for a merge that landed, using only the signed merge intent and a commit sha". Returns a result union; knows nothing about HTTP. |
| `apps/control-plane/src/queue/record-from-intent.test.ts` (create) | Tests for the extracted function's refusal paths. |
| `apps/control-plane/src/queue/routes.ts` (modify) | The `POST /repair` route becomes a thin caller that maps the result union onto status codes. |
| `apps/control-plane/src/queue/store.ts` (modify) | `unresolvedMergeOperations(startedBefore)` over SQL, plus the `UnresolvedMergeOperation` type. |
| `apps/control-plane/src/queue/snapshot-store.ts` (modify) | The same query over the document store. |
| `apps/control-plane/src/queue/store.test.ts` (modify) | Tests for the query, run against all three store implementations. |
| `apps/control-plane/src/queue/orphaned-writes.ts` (create) | Settle one unresolved write: read git, then record or refuse. |
| `apps/control-plane/src/queue/orphaned-writes.test.ts` (create) | Tests for the settle logic. |
| `apps/control-plane/src/queue/scheduled-tick.ts` (modify) | Call the sweep once per queue per tick. |
| `apps/control-plane/src/queue/chain-self-check.ts` (create) | Run `verifyChain` against the queue's own chain and report findings. |
| `apps/control-plane/src/queue/chain-self-check.test.ts` (create) | Tests for the self-check. |
| `apps/blog/src/content/blog/beta.mdoc` (modify, on a blog branch) | The research note. |

---

## Global Constraints

- **Never** pass `--no-verify` or `--no-gpg-sign` to git. Commits are signed.
- **Never** add an allowlist to `scripts/uncalled-exports.mjs`, `scripts/unwritten-fields.mjs`, or `knip.json`. If lint reports an export nothing imports, wire it or delete it.
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before every commit. All three must pass.
- Worker source may not import `node:` builtins. Tests may.
- Prose in comments, commit messages, and the blog post: no em dashes, no antithesis ("not X but Y"), no rule of three, no throat-clearing openers, no summary kicker.
- Work in the worktree at `~/Projects/_wt/recallnet/thwip/queue-inflight-reconcile`, never in `~/Projects/recallnet/thwip`.
- Build before typechecking after touching a package: `pnpm -r --filter './packages/**' run build && pnpm --filter @thwip/control-plane run build`.

---

## Task 1: Extract the record-from-intent path

`POST /v1/queue/:repositoryId/repair` (`routes.ts:3458-3685`) already contains the complete, reviewed logic for rebuilding a transition record from a signed merge intent plus a commit sha. The sweep in Task 3 needs exactly that. Extracting it first means one implementation of the signing path rather than two.

**Files:**
- Create: `apps/control-plane/src/queue/record-from-intent.ts`
- Create: `apps/control-plane/src/queue/record-from-intent.test.ts`
- Modify: `apps/control-plane/src/queue/routes.ts:3458-3685`

- [ ] **Step 1: Read the whole route before touching it**

```bash
cd ~/Projects/_wt/recallnet/thwip/queue-inflight-reconcile
sed -n '3424,3685p' apps/control-plane/src/queue/routes.ts
```

Lines 3424-3457 are the doc comment explaining why this route exists. It moves onto the extracted function, because it explains the mechanism rather than the HTTP surface.

- [ ] **Step 2: Create the new module with its types**

Create `apps/control-plane/src/queue/record-from-intent.ts`:

```ts
import type { QueueRouteEnv } from "./routes.js";

/**
 * Putting a merge back into the chain from what survives the attempt.
 *
 * The attempt does not survive the failure this exists for. A merge write is
 * authorized, GitHub answers 405 while it is still working out mergeability,
 * the workflow exits, the merge lands, and the attempt is terminated and
 * compacted. Four merges reached `main` that way in one morning.
 *
 * What survives is the signed merge intent. It is stored by digest and it names
 * the base, the head, the tree the queue authorized, the pull request, the
 * policy and the evidence, which is everything a transition record cites. So a
 * merge can be recorded long after the attempt is gone, and the caller supplies
 * one thing: a commit sha.
 *
 * Three things stop this recording a merge nobody authorized. The commit's tree
 * and parents come from GitHub rather than the caller. `authorizationFor`
 * returns an intent only where its pinned tree and pinned parents are exactly
 * that commit's. And the transition record schema refuses a record whose merged
 * tree is not the candidate tree and whose first and second parents are not the
 * base and head the intent names.
 *
 * Where the record goes is decided by the chain, not by when the merge
 * happened. The chain is hash-linked and append-only, so a record's position and
 * the digest of the record before it are inside the bytes that were signed.
 * Putting a merge back where it belongs chronologically would mean re-signing
 * every record after it, which is a rewrite, and refusing to rewrite is the
 * whole claim. A repair links the current head and takes the next sequence.
 */
export type RecordFromIntentRefusal =
  | "COMMIT_UNREADABLE"
  | "MERGE_NOT_ON_BASE"
  | "MERGE_NOT_AUTHORIZED"
  | "ATTEMPT_STILL_LIVE"
  | "BASE_UNREADABLE"
  | "SIGNING_REFUSED"
  | "CHAIN_MOVED";

export type RecordFromIntentResult =
  | {
      readonly status: "recorded";
      readonly attemptId: string;
      readonly pullRequestNumber: number | null;
      readonly mergeSha: string;
      readonly sequence: number;
      readonly transitionDigest: string;
      readonly mergeIntentDigest: string;
    }
  | {
      readonly status: "already";
      readonly attemptId: string;
      readonly pullRequestNumber: number | null;
      readonly transitionDigest: string;
    }
  | { readonly status: "refused"; readonly code: RecordFromIntentRefusal; readonly detail: string };
```

- [ ] **Step 3: Move the body across**

Move `routes.ts` lines 3481 (`const facts = await deps.commitFacts(...)`) through 3685 into an exported async function in the new module:

```ts
export async function recordMergeFromIntent<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: RecordFromIntentDeps<TEnv>,
  input: {
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly mergeSha: string;
    readonly witnessPrincipalId: string;
    readonly attemptId?: string;
  },
): Promise<RecordFromIntentResult>
```

Mechanical substitutions, applied exhaustively:

| In the route | In the function |
| --- | --- |
| `c.env` | `env` |
| `repositoryId`, `baseRef`, `mergeSha` | `input.repositoryId`, `input.baseRef`, `input.mergeSha` |
| `who.principalId` | `input.witnessPrincipalId` |
| `body.attemptId` | `input.attemptId` |
| `c.json({ error: "could not read that commit" }, 404)` | `{ status: "refused", code: "COMMIT_UNREADABLE", detail: "could not read that commit" }` |
| the `reachable !== true` block (409, `MERGE_NOT_ON_BASE`) | `{ status: "refused", code: "MERGE_NOT_ON_BASE", detail }` keeping both detail strings |
| `authorization.refused` (409, `MERGE_NOT_AUTHORIZED`) | `{ status: "refused", code: "MERGE_NOT_AUTHORIZED", detail: authorization.refused }` |
| the `intent.kind` guard (409, `MERGE_NOT_AUTHORIZED`) | `{ status: "refused", code: "MERGE_NOT_AUTHORIZED", detail: \`a ${intent.kind} merge cannot be rebuilt from its intent alone\` }` |
| the `already !== null` block | `{ status: "already", attemptId, pullRequestNumber: intent.pullRequestNumber, transitionDigest: already }` |
| `ATTEMPT_STILL_LIVE` (409) | `{ status: "refused", code: "ATTEMPT_STILL_LIVE", detail: "that attempt still holds the lane; reconcile it instead" }` |
| `c.json({ error: "could not read the base this merge started from" }, 404)` | `{ status: "refused", code: "BASE_UNREADABLE", detail: "could not read the base this merge started from" }` |
| `the queue refused to sign its own record: ...` (409) | `{ status: "refused", code: "SIGNING_REFUSED", detail: \`the queue refused to sign its own record: ${signed.error}\` }` |
| `!stored.stored` block | `{ status: "already", attemptId, pullRequestNumber: intent.pullRequestNumber, transitionDigest: stored.digest }` |
| `CHAIN_MOVED` (409) | `{ status: "refused", code: "CHAIN_MOVED", detail: "the chain moved while this record was being signed; try again" }` |
| the final success `c.json` | `{ status: "recorded", attemptId, pullRequestNumber: intent.pullRequestNumber, mergeSha: input.mergeSha, sequence: transitionSequence, transitionDigest: signed.digest, mergeIntentDigest: authorization.intentDigest }` |

The `reason` field on the success response is dropped from the function's result. It is an HTTP concern and the route adds it back.

`RecordFromIntentDeps<TEnv>` is the subset of the route's `deps` this code uses. Declare it explicitly:

```ts
export interface RecordFromIntentDeps<TEnv extends QueueRouteEnv> {
  commitFacts(
    env: TEnv,
    repositoryId: string,
    sha: string,
  ): Promise<{ treeOid: string; parentShas: string[]; message?: string } | null>;
  baseContainsSha(env: TEnv, repositoryId: string, baseRef: string, sha: string): Promise<boolean | null>;
  activePolicy(
    env: TEnv,
    repositoryId: string,
  ): Promise<{
    policyDigest: string;
    pipelineDigest: string | null;
    requiredSuites: readonly string[];
    organizationId: string;
  } | null>;
  onQueue: <T>(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
    decide: (parts: { store: SnapshotQueueStore; commands: QueueCommands }) => T,
  ) => Promise<{ result: T; snapshot: QueueSnapshot }>;
}
```

`authorizationFor`, `transitionRecordFor`, `readQueue`, `signReusedRecord` and `storeAttestation` are imported directly, the same way `routes.ts` imports them today. If any of them live inside `routes.ts` rather than a module, move that helper into the new file and have `routes.ts` import it back, so the dependency runs one way only.

- [ ] **Step 4: Reduce the route to a caller**

Replace the moved body in `routes.ts` with:

```ts
    const outcome = await recordMergeFromIntent(c.env, deps, {
      repositoryId,
      baseRef,
      mergeSha,
      witnessPrincipalId: who.principalId,
      ...(typeof body.attemptId === "string" ? { attemptId: body.attemptId } : {}),
    });

    if (outcome.status === "refused") {
      const status = outcome.code === "COMMIT_UNREADABLE" || outcome.code === "BASE_UNREADABLE" ? 404 : 409;
      return c.json({ error: outcome.detail, code: outcome.code }, status);
    }
    if (outcome.status === "already") {
      return c.json({
        recorded: "already",
        attemptId: outcome.attemptId,
        pullRequestNumber: outcome.pullRequestNumber,
        transitionDigest: outcome.transitionDigest,
      });
    }
    return c.json({
      recorded: "applied",
      attemptId: outcome.attemptId,
      pullRequestNumber: outcome.pullRequestNumber,
      mergeSha: outcome.mergeSha,
      sequence: outcome.sequence,
      transitionDigest: outcome.transitionDigest,
      mergeIntentDigest: outcome.mergeIntentDigest,
      actor: who.principalId,
      reason,
    });
```

The admin check, `requestedQueue`, and both body validations stay in the route. They are HTTP concerns.

Note the one behaviour change: the success body previously returned `recorded: result.transition.status`. The extracted function returns `status: "recorded"` only where the transition applied, so the route sends the literal `"applied"`. Check `chain-repair.test.ts` for an assertion on that field and update it if it asserts the old value.

- [ ] **Step 5: Run the existing repair tests**

Run: `npx vitest run apps/control-plane/src/queue/chain-repair.test.ts`
Expected: PASS, 12 tests. These tests drive the route over HTTP, so they prove the extraction preserved behaviour.

If any fail on the `recorded` field, fix the test to expect `"applied"`, not the function.

- [ ] **Step 6: Add refusal tests for the function directly**

Create `apps/control-plane/src/queue/record-from-intent.test.ts`. Follow the harness in `chain-repair.test.ts`: `testD1()` from `../../test/d1.js`, `signReusedIntent` from `./attestation.js`.

```ts
it("refuses a commit the base does not contain, because a record would claim the branch became it", async () => {
  const e = env();
  const deps = { ...stubDeps, baseContainsSha: async () => false };
  const outcome = await recordMergeFromIntent(e, deps, {
    repositoryId: REPO,
    baseRef: REF,
    mergeSha: "a".repeat(40),
    witnessPrincipalId: "prin_test",
  });
  expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_ON_BASE" });
});

it("refuses when the base cannot be asked, because unknown is not permission", async () => {
  const e = env();
  const deps = { ...stubDeps, baseContainsSha: async () => null };
  const outcome = await recordMergeFromIntent(e, deps, {
    repositoryId: REPO,
    baseRef: REF,
    mergeSha: "a".repeat(40),
    witnessPrincipalId: "prin_test",
  });
  expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_ON_BASE" });
});

it("refuses a commit the queue never authorized", async () => {
  const e = env();
  const outcome = await recordMergeFromIntent(e, stubDeps, {
    repositoryId: REPO,
    baseRef: REF,
    mergeSha: "b".repeat(40),
    witnessPrincipalId: "prin_test",
  });
  expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
});
```

`stubDeps` returns a readable commit, `baseContainsSha` true, a policy, and the real `onQueue`. Copy the fixture construction from `chain-repair.test.ts` rather than inventing one.

- [ ] **Step 7: Run the new tests**

Run: `npx vitest run apps/control-plane/src/queue/record-from-intent.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 8: Full gate**

```bash
pnpm -r --filter './packages/**' run build && pnpm --filter @thwip/control-plane run build
pnpm lint && pnpm typecheck && pnpm test
```
Expected: `lint: ok`, no typecheck errors, 1820+ tests passing.

- [ ] **Step 9: Commit**

```bash
git add apps/control-plane/src/queue/record-from-intent.ts \
        apps/control-plane/src/queue/record-from-intent.test.ts \
        apps/control-plane/src/queue/routes.ts \
        apps/control-plane/src/queue/chain-repair.test.ts
git commit -m "refactor(queue): one way to put a merge back in the chain

The repair route holds the only code that rebuilds a transition record from a
signed merge intent. The sweep that settles an orphaned write needs the same
thing, and a second copy of the signing path is the last thing this should grow."
```

---

## Task 2: Find writes nobody resolved

The store already carries `beginMergeOperation`, `resolveMergeOperation` and `mergeOperation(id)`. None of them can answer "which writes were started and never settled", which is why four of them sat unnoticed.

This code is already written in the worktree. Verify it against what follows, then commit it on its own.

An earlier draft of this plan said `pnpm lint` would fail here on an export nothing imports, and that is wrong. `unresolvedMergeOperations` is a method on a class, and `scripts/uncalled-exports.mjs` inspects module-level exports rather than class members, so lint reports `ok`. Commit this task by itself and do not wait for the sweep.

Worth knowing rather than acting on here: a class method nothing calls is the same bug family those checks exist for, and none of the three checks can currently see one. That is its own piece of work, not this one.

**Files:**
- Modify: `apps/control-plane/src/queue/store.ts`
- Modify: `apps/control-plane/src/queue/snapshot-store.ts`
- Modify: `apps/control-plane/src/queue/store.test.ts`

- [ ] **Step 1: Confirm the tests are present and green**

Run: `npx vitest run apps/control-plane/src/queue/store.test.ts`
Expected: PASS, 82 tests. The suite runs three times, against `BranchQueueStore`, `SnapshotQueueStore`, and `SnapshotQueueStore (compacted hard)`.

The five tests under `merge write guard > operations nobody resolved` are the ones that matter here. The load-bearing one:

```ts
it("finds one whose attempt no longer exists, because that is the case that stranded four merges", () => {
  const sql = backing();
  const store = open(sql, IDENTITY);
  store.beginMergeOperation(op);
  const reopened = open(sql, IDENTITY);
  expect(reopened.unresolvedMergeOperations("2026-07-29T12:25:00Z")).toHaveLength(1);
});
```

- [ ] **Step 2: Confirm the shape**

`store.ts` exports:

```ts
export interface UnresolvedMergeOperation {
  readonly operationId: string;
  readonly attemptId: string;
  readonly attemptRevision: number;
  readonly expectedBaseSha: string;
  readonly expectedHeadSha: string;
  readonly expectedTreeOid: string;
  readonly writeStartedAt: string;
}
```

Both stores implement `unresolvedMergeOperations(startedBefore: string): UnresolvedMergeOperation[]`, returning unresolved rows started strictly before the cutoff, ordered by `writeStartedAt` then `operationId`. `"unresolvedMergeOperations"` is in the `QueueStoreLike` key union near `store.ts:163`.

- [ ] **Step 3: Gate and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/control-plane/src/queue/store.ts \
        apps/control-plane/src/queue/snapshot-store.ts \
        apps/control-plane/src/queue/store.test.ts
git commit -m "feat(queue): find the merge writes nobody resolved

Three methods could start a write, settle one by id, and read one back. None
could answer which writes were started and never settled, which is why four of
them sat unnoticed while the chain went on without the merges they authorized."
```

---

## Task 3: Settle orphaned writes on the tick

**Files:**
- Create: `apps/control-plane/src/queue/orphaned-writes.ts`
- Create: `apps/control-plane/src/queue/orphaned-writes.test.ts`
- Modify: `apps/control-plane/src/queue/scheduled-tick.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/queue/orphaned-writes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { settleOrphanedWrite, ORPHANED_WRITE_GRACE_MS } from "./orphaned-writes.js";

const WRITE = {
  operationId: "merge_att_1",
  attemptId: "att_1",
  attemptRevision: 1,
  expectedBaseSha: "b".repeat(40),
  expectedHeadSha: "h".repeat(40),
  expectedTreeOid: "t".repeat(40),
  writeStartedAt: "2026-08-02T07:55:15Z",
};

describe("settleOrphanedWrite", () => {
  it("records the merge when git says the base contains the head", async () => {
    const resolved: Array<[string, string]> = [];
    const outcome = await settleOrphanedWrite(WRITE, {
      readMergeState: async () => ({ merged: true, mergeCommitSha: "m".repeat(40) }),
      baseContainsHead: async () => true,
      recordMerge: async (sha) => ({ status: "recorded", mergeSha: sha }),
      resolve: (id, o) => resolved.push([id, o]),
    });
    expect(outcome).toMatchObject({ settled: "merged", mergeSha: "m".repeat(40) });
    expect(resolved).toEqual([["merge_att_1", "MERGED"]]);
  });

  it("resolves not-merged only when every read agrees", async () => {
    const resolved: Array<[string, string]> = [];
    const outcome = await settleOrphanedWrite(WRITE, {
      readMergeState: async () => ({ merged: false, mergeCommitSha: null }),
      baseContainsHead: async () => false,
      recordMerge: async () => ({ status: "recorded", mergeSha: "" }),
      resolve: (id, o) => resolved.push([id, o]),
    });
    expect(outcome).toMatchObject({ settled: "not-merged" });
    expect(resolved).toEqual([["merge_att_1", "CONFIRMED_NOT_MERGED"]]);
  });

  /**
   * The whole failure this exists for began with one unreadable answer turned
   * into a durable conclusion. An unknown write stays unresolved and comes back
   * on the next tick, forever if that is what it takes.
   */
  it("leaves an unreadable write unresolved rather than concluding anything", async () => {
    const resolved: Array<[string, string]> = [];
    const outcome = await settleOrphanedWrite(WRITE, {
      readMergeState: async () => null,
      baseContainsHead: async () => null,
      recordMerge: async () => ({ status: "recorded", mergeSha: "" }),
      resolve: (id, o) => resolved.push([id, o]),
    });
    expect(outcome).toMatchObject({ settled: "unknown" });
    expect(resolved).toEqual([]);
  });

  /**
   * A merge that landed and cannot be recorded must not be marked settled. The
   * row is the only remaining evidence that anything needs doing.
   */
  it("leaves the write unresolved when the merge landed and the record could not be built", async () => {
    const resolved: Array<[string, string]> = [];
    const outcome = await settleOrphanedWrite(WRITE, {
      readMergeState: async () => ({ merged: true, mergeCommitSha: "m".repeat(40) }),
      baseContainsHead: async () => true,
      recordMerge: async () => ({ status: "refused", code: "CHAIN_MOVED", detail: "the chain moved" }),
      resolve: (id, o) => resolved.push([id, o]),
    });
    expect(outcome).toMatchObject({ settled: "unknown" });
    expect(resolved).toEqual([]);
  });

  /**
   * The pull request read can lag its own write, so git ancestry settles it.
   * That is the exact read that produced four false negatives.
   */
  it("trusts git ancestry over a pull request that has not caught up", async () => {
    const outcome = await settleOrphanedWrite(WRITE, {
      readMergeState: async () => ({ merged: false, mergeCommitSha: null }),
      baseContainsHead: async () => true,
      recordMerge: async (sha) => ({ status: "recorded", mergeSha: sha }),
      resolve: () => {},
    });
    expect(outcome).toMatchObject({ settled: "merged" });
  });

  it("waits long enough that a live workflow reports for itself", () => {
    expect(ORPHANED_WRITE_GRACE_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/control-plane/src/queue/orphaned-writes.test.ts`
Expected: FAIL, `Failed to resolve import "./orphaned-writes.js"`.

- [ ] **Step 3: Implement**

Create `apps/control-plane/src/queue/orphaned-writes.ts`:

```ts
import type { UnresolvedMergeOperation } from "./store.js";
import type { RecordFromIntentResult } from "./record-from-intent.js";

/**
 * Settling a merge write the workflow walked away from.
 *
 * A write is authorized, GitHub answers 405 while it is still working out
 * mergeability, and the workflow exits saying it leaves the outcome to
 * reconciliation. There was no reconciliation for this: the only sweep keyed off
 * a surviving attempt, and the attempt is terminated and compacted long before
 * anybody looks. Four merges reached `main` that way on 2 August 2026 and the
 * chain has no link for any of them.
 *
 * So the write settles itself, from git, and the workflow's report becomes the
 * fast path rather than the only path.
 *
 * Every arm that cannot conclude leaves the row alone. The row is the only
 * surviving evidence that a write is outstanding, and clearing it on a read
 * nobody could complete is how the original failure worked.
 */

/** Ten minutes. Longer than any merge workflow run observed on this repository. */
export const ORPHANED_WRITE_GRACE_MS = 10 * 60 * 1000;

export interface OrphanedWriteReads {
  /** What the pull request says about itself, or null when it could not be read. */
  readMergeState(): Promise<{ merged: boolean; mergeCommitSha: string | null } | null>;
  /** Whether the base branch contains the head commit, from git ancestry. */
  baseContainsHead(): Promise<boolean | null>;
  /** Build, sign and record the transition from the signed merge intent. */
  recordMerge(mergeSha: string): Promise<RecordFromIntentResult>;
  resolve(operationId: string, outcome: "MERGED" | "CONFIRMED_NOT_MERGED"): void;
}

export type OrphanedWriteOutcome =
  | { readonly settled: "merged"; readonly operationId: string; readonly mergeSha: string }
  | { readonly settled: "not-merged"; readonly operationId: string }
  | { readonly settled: "unknown"; readonly operationId: string; readonly reason: string };

export async function settleOrphanedWrite(
  write: UnresolvedMergeOperation,
  reads: OrphanedWriteReads,
): Promise<OrphanedWriteOutcome> {
  const pull = await reads.readMergeState();
  const contains = await reads.baseContainsHead();

  // Git settles it either way round. A pull request that reports itself merged
  // is enough, and so is ancestry when the pull request has not caught up with
  // its own merge.
  const landed = pull?.merged === true || contains === true;

  if (landed) {
    // `merge_commit_sha` on an open pull request holds the test merge GitHub
    // computes for it, which has the real merge's tree and parents and is on no
    // branch. Ancestry is what the record must rest on, so a sha is only taken
    // from a pull request that reports itself merged.
    const mergeSha = pull?.merged === true ? pull.mergeCommitSha : null;
    if (mergeSha === null) {
      return { settled: "unknown", operationId: write.operationId, reason: "the merge landed and GitHub named no commit" };
    }
    const recorded = await reads.recordMerge(mergeSha);
    if (recorded.status === "refused") {
      return { settled: "unknown", operationId: write.operationId, reason: recorded.detail };
    }
    reads.resolve(write.operationId, "MERGED");
    return { settled: "merged", operationId: write.operationId, mergeSha };
  }

  if (pull !== null && contains === false) {
    reads.resolve(write.operationId, "CONFIRMED_NOT_MERGED");
    return { settled: "not-merged", operationId: write.operationId };
  }

  return { settled: "unknown", operationId: write.operationId, reason: "GitHub could not be read well enough to say" };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run apps/control-plane/src/queue/orphaned-writes.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into the tick**

In `apps/control-plane/src/queue/scheduled-tick.ts`, inside the per-queue `try` block and after the `swept.overdue` handling (around line 162), add:

```ts
      // A write the workflow walked away from is nobody's job until it is this
      // one's. `settleReconciliation` above needs a surviving attempt; these
      // rows outlive every attempt, which is why four merges sat unrecorded.
      const cutoff = new Date(Date.now() - ORPHANED_WRITE_GRACE_MS).toISOString();
      const orphaned = await withQueueState(db, row.repositoryId, row.baseRef, async (store) =>
        store.unresolvedMergeOperations(cutoff),
      );
      for (const write of orphaned) {
        const outcome = await settleOrphanedWrite(write, {
          readMergeState: () => reads.pullRequestMergeState(env, row.repositoryId, write.pullRequestNumber),
          baseContainsHead: () => reads.baseContainsSha(env, row.repositoryId, row.baseRef, write.expectedHeadSha),
          recordMerge: (mergeSha) =>
            recordMergeFromIntent(env, recordDeps, {
              repositoryId: row.repositoryId,
              baseRef: row.baseRef,
              mergeSha,
              witnessPrincipalId: "queue",
              attemptId: write.attemptId,
            }),
          resolve: (operationId, resolvedAs) => {
            void withQueueState(db, row.repositoryId, row.baseRef, async (store) =>
              store.resolveMergeOperation(operationId, resolvedAs, new Date().toISOString()),
            );
          },
        });
        settledWrites += 1;
        // Said out loud on the channel this account watches. Something repairing
        // the chain silently is worse than the gap it closes.
        console.log(
          `[queue heartbeat] settled orphaned merge write ${write.operationId} for repository ` +
            `${row.repositoryId}: ${outcome.settled}`,
        );
      }
```

Two problems to solve while wiring, and both must be solved rather than worked around:

1. `UnresolvedMergeOperation` has no `pullRequestNumber`. Either add `pull_request_number` to the `merge_operations` row in `beginMergeOperation` and to the query in Task 2, or look the number up from the snapshot's entry for `write.attemptId`. Prefer adding the column: the entry does not survive compaction either, which is the same mistake one level down. Adding the column means a migration; follow whatever migration pattern `apps/control-plane` already uses for `merge_operations`.
2. `resolve` is synchronous in the port and the store write is async. Change the port to `resolve(operationId, outcome): Promise<void>` and `await` it, rather than firing `void`. Update the four `resolve:` stubs in the test to `async () => {}` and the assertions accordingly. A fire-and-forget resolve inside a Worker can be cut off, which is the same class of bug as the one being fixed.

Add `settledWrites` to the counters returned by `tickAllQueues` alongside `reconciled`, and to its return type, so a sweep that ran shows up in the heartbeat rather than being invisible.

Import at the top of `scheduled-tick.ts`:

```ts
import { ORPHANED_WRITE_GRACE_MS, settleOrphanedWrite } from "./orphaned-writes.js";
import { recordMergeFromIntent } from "./record-from-intent.js";
```

`recordDeps` is the same dependency object `routes.ts` passes to `recordMergeFromIntent`. Export it from wherever `routes.ts` builds its `deps` so both callers share one construction.

- [ ] **Step 6: Add a tick-level test**

In `apps/control-plane/src/queue/scheduled-tick.test.ts` (or `deadlines.test.ts` if the tick tests live there; check with `grep -rl tickAllQueues apps/control-plane/src --include='*.test.ts'`), add:

```ts
it("settles a merge write left unresolved by a workflow that exited", async () => {
  // Arrange a queue with one merge_operations row started twenty minutes ago,
  // no surviving attempt, and GitHub reporting the merge landed.
  const result = await tickAllQueues(env, ports, readsThatSayMerged);
  expect(result.settledWrites).toBe(1);
  const remaining = await withQueueState(db, REPO, REF, async (store) =>
    store.unresolvedMergeOperations(new Date().toISOString()),
  );
  expect(remaining).toEqual([]);
});
```

- [ ] **Step 7: Full gate**

```bash
pnpm -r --filter './packages/**' run build && pnpm --filter @thwip/control-plane run build
pnpm lint && pnpm typecheck && pnpm test
```
Expected: `lint: ok`, no typecheck errors, and the full suite green.

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane/src/queue/orphaned-writes.ts \
        apps/control-plane/src/queue/orphaned-writes.test.ts \
        apps/control-plane/src/queue/scheduled-tick.ts \
        apps/control-plane/src/queue/store.ts \
        apps/control-plane/src/queue/snapshot-store.ts
git commit -m "fix(queue): a merge write settles itself

The obligation to settle a write belonged to the attempt, and the attempt does
not survive the failure that needs settling. GitHub answers 405 while it works
out mergeability, the workflow exits, the merge lands, and the attempt is
compacted with the write still open. Four merges reached main that way and the
chain has no link for any of them.

The write now carries the obligation and the tick settles it from git ancestry,
so the workflow's report is the fast path rather than the only path."
```

---

## Task 4: Verify the chain on a schedule

`verifyChain` in `packages/queue-protocol` already reports `BASE_DISCONTINUITY`. Nothing runs it, which is why a gap opened in August and was found by hand in a blog-post measurement.

**Files:**
- Create: `apps/control-plane/src/queue/chain-self-check.ts`
- Create: `apps/control-plane/src/queue/chain-self-check.test.ts`
- Modify: `apps/control-plane/src/queue/scheduled-tick.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/queue/chain-self-check.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkOwnChain } from "./chain-self-check.js";

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
```

Build `linksWithAGap()` and `intactLinks()` from the fixtures in `packages/queue-protocol/src/verify-chain.test.ts`. Reuse them; do not invent a second chain fixture.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/control-plane/src/queue/chain-self-check.test.ts`
Expected: FAIL, `Failed to resolve import "./chain-self-check.js"`.

- [ ] **Step 3: Implement**

Create `apps/control-plane/src/queue/chain-self-check.ts`:

```ts
import { verifyChain, type ChainFinding, type ChainLink, type ChainVerifierPorts } from "@thwip/queue-protocol";

/**
 * Reading the queue's own chain the way an outsider would.
 *
 * `verifyChain` has reported `BASE_DISCONTINUITY` since the day a missing merge
 * was first understood, and nothing ran it. Four merges were missing from this
 * repository's chain for a day before anybody looked, and they were found by a
 * script written for a blog post. A check nobody runs is a check that does not
 * exist.
 *
 * `NOTHING_CHECKED` is this module's own finding rather than the verifier's. An
 * `epochStartsAt` past the end of the chain makes every link skip its signature
 * and produces no finding at all, so a caller reading only `findings.length`
 * would call that chain clean having verified nothing.
 */
export type SelfCheckFinding = ChainFinding | { code: "NOTHING_CHECKED"; sequence: null; digest: ""; detail: string };

export async function checkOwnChain(
  links: readonly ChainLink[],
  ports: ChainVerifierPorts,
): Promise<SelfCheckFinding[]> {
  const result = await verifyChain(links, ports);
  const findings: SelfCheckFinding[] = [...result.findings];
  if (links.length > 0 && result.signaturesChecked === 0) {
    findings.push({
      code: "NOTHING_CHECKED",
      sequence: null,
      digest: "",
      detail: `the walk read ${links.length} link(s) and verified no signature`,
    });
  }
  return findings;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run apps/control-plane/src/queue/chain-self-check.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire it into the tick**

In `scheduled-tick.ts`, after the orphaned-write sweep, read the queue's links and run the check. Log every finding at `console.error` so it reaches the same channel as the other heartbeat output, and add a `chainFindings` counter to the return value.

Read the links the same way the chain route does. Find it with:

```bash
grep -n 'chain' apps/control-plane/src/queue/chain-route.ts | head -20
```

Reuse that reader rather than writing a second one. If it is not exported, export it.

Run the check once per tick per queue. It reads rows the tick already has a connection for and verifies signatures over bytes already in memory.

- [ ] **Step 6: Full gate and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/control-plane/src/queue/chain-self-check.ts \
        apps/control-plane/src/queue/chain-self-check.test.ts \
        apps/control-plane/src/queue/scheduled-tick.ts
git commit -m "feat(queue): the queue reads its own chain

verifyChain has reported a missing merge since the day the failure was
understood, and nothing ran it. Four merges were absent from this chain for a
day and a script written for a blog post found them."
```

---

## Task 5: Ship the fix

- [ ] **Step 1: Open the pull request**

```bash
thwip run && thwip ship
```

`thwip ship` signs a proof over the head tree and opens the pull request through the queue, so this change meets the evidence bar it is about.

- [ ] **Step 2: Wait for the six checks and the merge**

Do not merge by hand. The queue merges it.

- [ ] **Step 3: Deploy**

```bash
cd apps/control-plane && pnpm run deploy:staging
```

Requires the operator's wrangler OAuth session. If `wrangler whoami` fails, ask the operator to run `wrangler login`; there is no D1-capable API token on this machine and the one in `.env.d` is DNS-scoped by design.

- [ ] **Step 4: Confirm the sweep is live**

Wait for one cron tick, then check the log for `[queue heartbeat]`. A tick that finds nothing prints nothing, which is correct.

---

## Task 6: Repair the four stranded merges

This writes four permanent records to the live chain. Run it only after Task 5 is deployed, so the cause is fixed before the symptom.

Each `POST /repair` needs repository-admin auth against `https://thwip.recall.net`.

- [ ] **Step 1: Record the state before**

```bash
node scripts/verify-chain.mjs 1315419165 > /tmp/chain-before.txt
cat /tmp/chain-before.txt
```
Expected: 48 links, 48 signatures verified, 3 `BASE_DISCONTINUITY` findings.

- [ ] **Step 2: Repair each merge, oldest first**

```bash
for sha in 812d3a8 33db87a 74add77 4c7b9c7; do
  full=$(git rev-parse "$sha")
  curl -sS -X POST "https://thwip.recall.net/v1/queue/1315419165/repair?ref=refs/heads/main" \
    -H "authorization: Bearer $THWIP_ADMIN_TOKEN" \
    -H "content-type: application/json" \
    -d "{\"mergeSha\":\"$full\",\"reason\":\"merge write left unresolved when the workflow exited on a 405\"}"
  echo
done
```

Expected per call: `{"recorded":"applied", ...}` with a `sequence` and a `transitionDigest`.

A `MERGE_NOT_AUTHORIZED` means the stored intent does not pin that commit's tree and parents. Stop and investigate rather than forcing it. `CHAIN_MOVED` means a real merge landed mid-repair; re-run that one sha.

- [ ] **Step 3: Confirm the chain is whole**

```bash
node scripts/verify-chain.mjs 1315419165
```
Expected: 52 links, 52 signatures verified, `no findings`.

Note that the four repaired records sit at the chain's current head rather than in the order the merges landed. That is the append-only property working, and the blog post says so.

- [ ] **Step 4: Confirm no operation is still open**

```bash
curl -s -H "authorization: Bearer $THWIP_TOKEN" \
  "https://thwip.recall.net/v1/queue/1315419165/explain?ref=refs%2Fheads%2Fmain" \
  | jq '[.mergeOperations[] | select(.outcome == null)] | length'
```
Expected: 0. This used to be a remote SQL statement against the live database;
`/explain` reports the merge writes now. See `docs/production-access.md`.

---

## Task 7: Finalize and publish the research note

The rewritten post is on `main` in `~/Projects/recallnet/thwip`, uncommitted, along with three figures, `scripts/verify-chain.mjs`, and the design spec at `docs/superpowers/specs/2026-08-03-research-note-redesign-design.md`. Read that spec first: it holds the four binding rules the post has to satisfy.

Do this work on its own branch, not on `main`, and not in the queue worktree.

**Files:**
- Modify: `apps/blog/src/content/blog/beta.mdoc`
- Add: `apps/blog/public/blog/fig-trace-vs-tree.svg`, `fig-toctou.svg`, `fig-setup-vs-work.svg`
- Add: `scripts/verify-chain.mjs`
- Add: `docs/superpowers/specs/2026-08-03-research-note-redesign-design.md`

- [ ] **Step 1: Create the branch**

```bash
cd ~/Projects/recallnet/thwip
wtnew research-note
```

Move the uncommitted files across, then confirm `~/Projects/recallnet/thwip` is clean.

- [ ] **Step 2: Write the post as though the repository and packages are public**

**Decided on 2026-08-03.** Write every link and every claim as if `recallnet/thwip` is public and the workspace packages are on npm. The operator decides when to flip visibility and when to publish, and that happens before the post goes out rather than being designed around here.

So keep the draft as it stands: the `github.com/recallnet/thwip/tree/main/...` links in **Sources and code**, the ADR link, the schema links, the invitation to open issues, and the closing line about the monorepo being public. Do not weaken, hedge, or remove any of them.

Note for whoever flips the switch, and not something the post says: the workspace scope is `@thwip/*` while the only published package is `@recallnet/thwip`, so the scopes need reconciling before `packages/queue-protocol` can be installed by a reader.

- [ ] **Step 3: Update the chain measurements**

The post's measurements were taken before Task 6. Re-run and update:

```bash
node scripts/verify-chain.mjs 1315419165
```

Update the **Measurements** section with the post-repair figures: link count, signatures verified, record-kind distribution, and the count of `base-correction` records. Keep the pre-repair state in the prose, because the interesting fact is that the checker found gaps in its author's own chain.

- [ ] **Step 4: Add the incident to the post**

This is the strongest material the note has and it postdates the draft. Add it to the **Measurements** section, after the posture paragraph:

State that the chain-verification script, written for this post, reported three `BASE_DISCONTINUITY` findings covering four merges; that the cause was a merge write the workflow abandoned after a transient GitHub 405 with no reconciliation for an operation whose attempt had been compacted; that the fix moved the obligation onto the write itself; and that the four records were repaired and sit at the chain head rather than in the order the merges landed.

Keep it factual and short. It belongs in the post because the post claims falsifiability, and this is the claim being exercised against its author.

- [ ] **Step 5: Build the corpus figure**

The spec calls for a fourth figure, F4, from whichever measurement survived extraction. Build `apps/blog/public/blog/fig-chain-kinds.svg` showing the record-kind distribution after repair, in the site palette (`--paper #ffffff`, `--ink #1b1b1b`, `--civic #005ea2`, `--muted #565c65`, `--rule #dfe1e2`), 1200 wide, matching the three existing figures. Reference it with `{% product-shot %}`.

- [ ] **Step 6: De-slop the prose**

Run the `stop-slop` skill over `beta.mdoc`. The binding rules are in the Global Constraints above. Pay attention to the sections written last, which are the likeliest to carry throat-clearing openers.

- [ ] **Step 7: Check every external claim**

Re-verify each citation resolves and each number matches its source:

- arXiv 2606.04990, authors led by Yiqi Wang, execution provenance as a typed graph
- arXiv 2607.05743, Rashidi, 39 papers, 17 categories, 69% to 98% policy-enforcement failure
- arXiv 2607.04697v2, Xu, Subramanian and Karthik, 33,596 pull requests, 2,807 repositories, 79.4% concurrent, 41.7% cross-agent conflict
- arXiv 2607.12428, Sakib, Banik and Jadliwala, roughly 2.7x vulnerability rate
- GitHub Actions 2-core Linux at $0.006 per minute from 1 January 2026
- Octoverse 2025 for the commit volume

Author surnames were fabricated on the first draft and corrected. Check them again rather than trusting the draft.

- [ ] **Step 8: Build the blog and look at it**

```bash
pnpm --filter @thwip/control-plane run build
```

Open the rendered post. Check the editorial QA points from the spec: one content column, styled tables with borders and header weight, readable code blocks, figures scrolling rather than overflowing on narrow viewports, and both light and dark treatments.

- [ ] **Step 9: Full gate and ship**

```bash
pnpm lint && pnpm typecheck && pnpm test
thwip run && thwip ship
```

---

## Self-Review

**Spec coverage.** The design spec's four binding rules map to Task 7: R1 install path leaves (Step 2 and the existing draft), R2 runnable artifacts (`scripts/verify-chain.mjs` in Step 1, chain figures in Step 3), R3 two classes of number (Step 7), R4 the attack in the body (already in the draft's **What a proof does not buy**). The spec's F1 through F3 exist; F4 is Step 5.

**Gap found and closed.** The spec assumed the repository was public. Step 2 makes that an explicit decision that blocks publication rather than an assumption.

**Type consistency.** `RecordFromIntentResult` is defined in Task 1 and consumed by `OrphanedWriteReads.recordMerge` in Task 3. `UnresolvedMergeOperation` is defined in Task 2 and consumed in Task 3. `unresolvedMergeOperations(startedBefore)` keeps one name and one signature throughout.

**Two known rough edges, called out in Task 3 Step 5 rather than hidden:** `UnresolvedMergeOperation` has no `pullRequestNumber` yet and needs a column, and the `resolve` port must be async. Both are stated with the reasoning for the preferred fix.
