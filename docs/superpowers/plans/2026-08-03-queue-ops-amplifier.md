# Queue Ops Amplifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the control plane paying a queue write and a full installation sync for GitHub webhooks that carry no work, so the Queues free tier is not exhausted before the machinery that depends on it can run.

**Architecture:** One exported predicate decides whether a delivery carries work, and the webhook route enqueues only when it does. Installation sync moves off the every-message path onto the events that actually change installation state, with the daily cron still covering drift.

**Tech Stack:** TypeScript on Cloudflare Workers, Cloudflare Queues, D1, Hono, vitest.

---

## Why this is urgent

On 2026-08-03 this account hit 100% of the Queues free tier, 10,000 daily
operations, from this single project. New queue sends fail until 00:00 UTC.

The consequence is not only cost. The `*/5 * * * *` cron runs `tickAllQueues`,
which is what settles orphaned merge writes and verifies the queue's own chain.
Both shipped today in PR #142. While the queue is capped, the tick cannot
complete, so five merge writes sit unresolved in production and the chain still
reports three `BASE_DISCONTINUITY` findings. The outage disables the safety
machinery first.

The limit resets at 00:00 UTC and the same traffic pattern will drain it again.

## The cause, both layers

**Layer one, the producer.** `apps/control-plane/src/index.ts`, in
`POST /api/github/webhooks`, calls `SYNC_QUEUE.send(...)` for every delivery.
It computes `policyPush`, `appProofTask`, and `reconcileProofRepositoryId`
immediately before, and sends even when all three are null.

**Layer two, the consumer.** The `async queue(...)` handler calls
`syncInstallation(env, inst)` for every message carrying an installation id,
deduplicated only within one batch. An empty message still costs a GitHub read
and D1 writes.

**The amplifier.** The App subscribes to `check_run` and `check_suite`, the two
chattiest event types GitHub emits, and it publishes six checks itself: `thwip`,
`thwip / turn`, `thwip / lint`, `thwip / test`, `thwip / typecheck`, and
`thwip / candidate`. Every check it publishes makes GitHub fire `check_run`
webhooks straight back. Under agent-cadence merge volume that compounds.

## What actually carries work

Read from the consumer, which is the authority. A message does something only
when one of these holds:

| Condition in the consumer | What it runs |
| --- | --- |
| `body.policyPush != null` | `activatePolicyFromDefaultBranchPush` |
| `body.event === "policy_reconcile"` | `reconcileInstallationPolicies`, `reconcileInstallationProofChecks` |
| `body.reconcileProofRepositoryId` | `reconcileProjectProofChecks` |
| `body.appProofTask` | `processAppProof` |
| `body.event` in `member`, `membership`, `organization`, `repository`, `team` | `reconcileInstallationProofChecks` |
| any message with an installation id | `syncInstallation` |

`appProofTaskFromWebhook` (`apps/control-plane/src/app-proof-verification.ts:147`)
already returns null for everything except `check_run` (`rerequested`,
`completed`), `check_suite` (`rerequested`), `pull_request` (the actions in
`PULL_REQUEST_ACTIONS`), and `merge_group` (`checks_requested`). It is a
reliable authority for proof work; do not re-derive it.

The last row is the one that makes every delivery expensive, and it is the row
with no justification. `installation` and `installation_repositories` change
installation state. A `check_run` completing does not.

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/control-plane/src/webhook-work.ts` (create) | One exported predicate, `webhookWork(event, payload)`, returning the message to enqueue or null. The single place that decides whether a delivery is worth a queue operation. |
| `apps/control-plane/src/webhook-work.test.ts` (create) | Tests, including a drift guard tying the predicate to the consumer's conditions. |
| `apps/control-plane/src/index.ts` (modify) | The webhook route calls the predicate and skips the send when it returns null. The consumer syncs the installation only for events that change installation state. |

## Global Constraints

- **Never** pass `--no-verify` or `--no-gpg-sign`. Commits are signed.
- **Never** add an allowlist to `scripts/uncalled-exports.mjs`, `scripts/unwritten-fields.mjs`, or `knip.json`.
- Worker source (`apps/control-plane/src/**`, excluding `*.test.ts`) may not import `node:` builtins.
- Gate before every commit: `pnpm lint && pnpm typecheck && pnpm test`. Baseline is 1873 passing across 129 files.
- Build first after touching packages: `pnpm -r --filter './packages/**' run build && pnpm --filter @thwip/control-plane run build`
- Work in a worktree under `~/Projects/_wt/`, created with `wtnew`. Never work in `~/Projects/recallnet/thwip`.
- Prose in comments and commit messages: no em dashes, no antithesis, no corrective negation, no rule of three, no throat-clearing openers, no summary kicker.
- **Do not silently drop work.** Every event the consumer acts on must still be enqueued. A dropped `pull_request` event means a proof never gets verified and a merge gate never publishes, which is worse than the cost this plan is fixing.

---

## Task 0: Worktree

- [ ] **Step 1: Create it**

```bash
cd ~/Projects/recallnet/thwip
git checkout main && git pull --ff-only
wtnew queue-ops-amplifier
```

`wtnew` may report `pnpm build failed` on the blog step. That is a build-ordering
quirk in a fresh worktree and it is not your problem. Fix it with:

```bash
cd ~/Projects/_wt/recallnet/thwip/queue-ops-amplifier
pnpm -r --filter './packages/**' run build && pnpm --filter @thwip/control-plane run build
```

- [ ] **Step 2: Copy this plan in**

```bash
cp ~/Projects/recallnet/thwip/docs/superpowers/plans/2026-08-03-queue-ops-amplifier.md \
   ~/Projects/_wt/recallnet/thwip/queue-ops-amplifier/docs/superpowers/plans/
```

---

## Task 1: One predicate for whether a delivery is worth a queue operation

**Files:**
- Create: `apps/control-plane/src/webhook-work.ts`
- Create: `apps/control-plane/src/webhook-work.test.ts`
- Modify: `apps/control-plane/src/index.ts` (the `SYNC_QUEUE.send` in `POST /api/github/webhooks`, near line 1646)

- [ ] **Step 1: Read the two ends before writing anything**

```bash
cd ~/Projects/_wt/recallnet/thwip/queue-ops-amplifier
sed -n '1636,1656p' apps/control-plane/src/index.ts
grep -n 'async queue(' -A 40 apps/control-plane/src/index.ts
sed -n '147,205p' apps/control-plane/src/app-proof-verification.ts
```

The predicate you write must enqueue for every condition the consumer acts on.
If you find a condition in the consumer that the table in this plan missed, the
consumer wins. Add it and say so in your report.

- [ ] **Step 2: Write the failing test**

Create `apps/control-plane/src/webhook-work.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { INSTALLATION_STATE_EVENTS, webhookWork } from "./webhook-work.js";

const base = { delivery: "d1", installationId: "42" };

describe("webhookWork", () => {
  /**
   * The event that drained ten thousand operations in a day. The App publishes
   * six checks per commit, GitHub fires a check_run webhook for each one, and
   * every webhook used to cost a queue write and an installation sync while
   * carrying nothing the consumer would act on.
   */
  it("skips a completed check_run for a check the App does not verify", () => {
    expect(
      webhookWork("check_run", { action: "completed", check_run: { name: "some-other-ci" } }, base),
    ).toBeNull();
  });

  it("keeps a rerequested thwip check, because the consumer reruns the proof", () => {
    const work = webhookWork(
      "check_run",
      { action: "rerequested", check_run: { name: "thwip", external_id: "thwip:v1:abc" } },
      base,
    );
    expect(work?.appProofTask).not.toBeNull();
  });

  it("keeps a pull_request event, because a proof check hangs on it", () => {
    const work = webhookWork(
      "pull_request",
      { action: "opened", repository: { id: 1315419165 }, pull_request: { number: 1 } },
      base,
    );
    expect(work).not.toBeNull();
  });

  it("keeps a default-branch push, because policy activates from it", () => {
    const work = webhookWork(
      "push",
      { ref: "refs/heads/main", repository: { id: 1315419165, default_branch: "main" } },
      base,
    );
    expect(work?.reconcileProofRepositoryId).toBe("1315419165");
  });

  it("keeps a membership change, because the consumer reconciles proof checks for it", () => {
    expect(webhookWork("membership", { action: "added" }, base)).not.toBeNull();
  });

  it("keeps an installation change, because it is what actually changes installation state", () => {
    for (const event of INSTALLATION_STATE_EVENTS) {
      expect(webhookWork(event, { action: "created" }, base)).not.toBeNull();
    }
  });

  it("skips an event the consumer has no branch for", () => {
    expect(webhookWork("star", { action: "created" }, base)).toBeNull();
  });

  /**
   * A message with no installation id cannot be acted on: every branch in the
   * consumer that does work either needs the installation or a repository the
   * payload names.
   */
  it("skips a check_run rerequest with no installation", () => {
    expect(
      webhookWork(
        "check_run",
        { action: "rerequested", check_run: { name: "thwip", external_id: "thwip:v1:abc" } },
        { delivery: "d1", installationId: null },
      ),
    ).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run apps/control-plane/src/webhook-work.test.ts`
Expected: FAIL with `Failed to resolve import "./webhook-work.js"`.

- [ ] **Step 4: Implement the predicate**

Create `apps/control-plane/src/webhook-work.ts`:

```ts
import { appProofTaskFromWebhook, type AppProofTask } from "./app-proof-verification.js";
import { policyPushFromGithubWebhook, type PolicyPush } from "./policy-activation.js";

/**
 * Whether a webhook delivery is worth a queue operation.
 *
 * Every delivery used to buy one, and the consumer then synced the whole
 * installation for it. The App publishes six checks per commit and GitHub fires
 * a check_run webhook for each, so the App billed itself for its own output.
 * That drained a day's Queues budget, and the budget is what the five minute
 * cron runs on, so the machinery that settles orphaned merge writes and verifies
 * the chain went down first.
 *
 * The rule here is the consumer's own list of branches. Anything the consumer
 * would act on is enqueued. Anything else costs nothing, because a queue
 * operation that does no work is still an operation.
 */

/** Events after which the consumer's reconcile pass has something to reconcile. */
export const MEMBERSHIP_EVENTS = ["member", "membership", "organization", "repository", "team"] as const;

/**
 * Events that change what the installation covers. Syncing on anything else
 * asks GitHub to confirm what it just told us.
 */
export const INSTALLATION_STATE_EVENTS = ["installation", "installation_repositories"] as const;

export interface WebhookWork {
  readonly provider: "github";
  readonly delivery: string;
  readonly event: string;
  readonly installationId: string | null;
  readonly policyPush: PolicyPush | null;
  readonly appProofTask: AppProofTask | null;
  readonly reconcileProofRepositoryId: string | null;
  /** Whether the consumer should re-read the installation from GitHub. */
  readonly syncInstallation: boolean;
}

export function webhookWork(
  event: string,
  payload: {
    action?: string;
    ref?: string;
    repository?: { id?: number | string; default_branch?: string } | null;
  } & Record<string, unknown>,
  context: { delivery: string; installationId: string | null },
): WebhookWork | null {
  const policyPush = policyPushFromGithubWebhook(event, payload as never);
  const appProofTask = appProofTaskFromWebhook(event, payload as never);
  const reconcileProofRepositoryId =
    event === "push" &&
    payload.repository?.id != null &&
    payload.ref === `refs/heads/${payload.repository.default_branch ?? ""}`
      ? String(payload.repository.id)
      : null;

  const membership = (MEMBERSHIP_EVENTS as readonly string[]).includes(event);
  const installationState = (INSTALLATION_STATE_EVENTS as readonly string[]).includes(event);

  const work =
    policyPush !== null ||
    appProofTask !== null ||
    reconcileProofRepositoryId !== null ||
    membership ||
    installationState;
  if (!work) return null;

  // Every branch that does work needs either the installation or a repository
  // the installation covers, and both are reached through the installation
  // token. A delivery without one cannot be acted on.
  if (context.installationId === null) return null;

  return {
    provider: "github",
    delivery: context.delivery,
    event,
    installationId: context.installationId,
    policyPush,
    appProofTask,
    reconcileProofRepositoryId,
    syncInstallation: membership || installationState,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run apps/control-plane/src/webhook-work.test.ts`
Expected: PASS, 8 tests.

If `policyPushFromGithubWebhook` or `appProofTaskFromWebhook` is not exported
from the path shown, find it with
`grep -rn 'export function policyPushFromGithubWebhook' apps/control-plane/src`
and import from there.

- [ ] **Step 6: Use it in the webhook route**

In `apps/control-plane/src/index.ts`, replace the block that computes
`policyPush`, `appProofTask`, and `reconcileProofRepositoryId` and then sends,
near line 1638, with:

```ts
  const work = webhookWork(event, payload as never, { delivery, installationId });
  if (work === null) {
    // Deliberately silent about the common case. Most deliveries are check_run
    // events the App caused by publishing its own checks, and a log line each
    // would cost more than the send did.
    return c.json({ ok: true, duplicate, queued: { handled: false, detail: "no work in this delivery" } });
  }
  await c.env.SYNC_QUEUE.send(work);
  return c.json({ ok: true, duplicate, queued });
```

Import it at the top of the file:

```ts
import { webhookWork } from "./webhook-work.js";
```

Remove the now-unused local computations of `policyPush`, `appProofTask`, and
`reconcileProofRepositoryId` from that route. Leave every other use of
`policyPushFromGithubWebhook` and `appProofTaskFromWebhook` alone.

- [ ] **Step 7: Gate**

```bash
pnpm -r --filter './packages/**' run build && pnpm --filter @thwip/control-plane run build
pnpm lint && pnpm typecheck && pnpm test
```
Expected: `lint: ok`, no typecheck errors, 1881 tests passing (1873 plus the 8 new).

If a webhook test elsewhere now fails because it asserted a send for an event
that carries no work, read that test before changing it. If it was asserting the
old behaviour, update it and say so. If it was asserting that a real event
reaches the consumer, your predicate is wrong; fix the predicate.

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane/src/webhook-work.ts \
        apps/control-plane/src/webhook-work.test.ts \
        apps/control-plane/src/index.ts
git commit -m "fix(webhooks): stop paying a queue operation for nothing

Every delivery bought a queue write, and the consumer then synced the whole
installation for it. The App publishes six checks per commit and GitHub fires a
check_run webhook for each, so the App billed itself for its own output. A day's
budget went in a day, and the five minute cron runs on that budget, so the sweep
that settles orphaned merge writes stopped with it.

One predicate now decides whether a delivery carries work, derived from the
branches the consumer actually has."
```

---

## Task 2: Sync the installation for events that change it

**Files:**
- Modify: `apps/control-plane/src/index.ts` (the `async queue(...)` consumer, near line 2585)

- [ ] **Step 1: Write the failing test**

Find the consumer's existing tests with
`grep -rln 'async queue\|SYNC_QUEUE' apps/control-plane/src --include='*.test.ts'`.
Add to whichever file covers the consumer, or create
`apps/control-plane/src/queue-consumer.test.ts` following the harness that file
uses:

```ts
it("does not re-read the installation for a proof task that changed nothing about it", async () => {
  const synced: string[] = [];
  await runConsumer(
    [{ event: "check_run", installationId: "42", appProofTask: { kind: "verify", request: REQUEST }, syncInstallation: false }],
    { syncInstallation: async (id: string) => { synced.push(id); } },
  );
  expect(synced).toEqual([]);
});

it("re-reads the installation when the installation itself changed", async () => {
  const synced: string[] = [];
  await runConsumer(
    [{ event: "installation_repositories", installationId: "42", syncInstallation: true }],
    { syncInstallation: async (id: string) => { synced.push(id); } },
  );
  expect(synced).toEqual(["42"]);
});
```

If the consumer is not currently testable without a live `Env`, extract its body
into an exported function that takes its dependencies, and test that. Do not
skip this task because the consumer is awkward to test.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/control-plane/src/queue-consumer.test.ts`
Expected: FAIL, because the consumer syncs for every message.

- [ ] **Step 3: Gate the sync on the flag**

In the consumer, replace:

```ts
        if (inst && !synced.has(inst)) {
          await syncInstallation(env, inst);
          synced.add(inst);
          if (["member", "membership", "organization", "repository", "team"].includes(body.event ?? "")) {
            await reconcileInstallationProofChecks(env, inst);
          }
        }
```

with:

```ts
        // Syncing on every message asked GitHub to confirm what it had just
        // told us, once per delivery. The producer now says when a delivery
        // changed what the installation covers, and the daily reconciliation
        // still catches anything that drifted in between.
        if (inst && body.syncInstallation === true && !synced.has(inst)) {
          await syncInstallation(env, inst);
          synced.add(inst);
          if (MEMBERSHIP_EVENTS.includes(body.event ?? "")) {
            await reconcileInstallationProofChecks(env, inst);
          }
        }
```

Widen the message type at the top of the consumer to include
`syncInstallation?: boolean`, and import `MEMBERSHIP_EVENTS` from
`./webhook-work.js`.

The daily cron already calls `syncInstallation`, `reconcileInstallationPolicies`,
and `reconcileInstallationProofChecks` for every active organization, so drift
has a floor.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run apps/control-plane/src/queue-consumer.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/control-plane/src/index.ts apps/control-plane/src/queue-consumer.test.ts
git commit -m "fix(webhooks): re-read an installation when it changed

The consumer synced the installation for every message that carried an id,
deduplicated only inside one batch, so a check_run event cost a GitHub read and
a set of D1 writes to confirm nothing. The producer now says which deliveries
changed what the installation covers, and the daily reconciliation still covers
drift."
```

---

## Task 3: Ship, deploy, and prove the drain stopped

- [ ] **Step 1: Ship through the queue**

```bash
thwip run && thwip ship
```

Queue sends are capped until 00:00 UTC, so the merge may not proceed until the
reset. Check with `gh pr view <number> --json state,statusCheckRollup`. If the
checks stall, wait for the reset rather than merging by hand.

- [ ] **Step 2: Deploy**

```bash
cd apps/control-plane && pnpm run deploy:staging
```

- [ ] **Step 3: Record the baseline before the next busy period**

Note the Queues usage at the dashboard link in the limit notice, with a
timestamp, so the next day's number can be compared against something.

- [ ] **Step 4: Prove the tick recovered**

The five open merge writes and the three `BASE_DISCONTINUITY` findings are the
acceptance test for this plan and for PR #142 together.

```bash
node scripts/verify-chain.mjs 1315419165
```

Expected after one tick past the reset: `no findings`, and the record kinds
gaining four `reused-proof-merge` entries.

**Do not grep this script's output for a finding count without checking that it
ran.** A previous session reported the chain whole when the script had failed
with `MODULE_NOT_FOUND` and the grep counted zero matches in a stack trace. Check
the exit code, and check that the `links` line is present.

```bash
node scripts/verify-chain.mjs 1315419165 > /tmp/chain.txt; echo "exit=$?"; head -3 /tmp/chain.txt
```

- [ ] **Step 5: Confirm the writes settled**

```bash
curl -s -H "authorization: Bearer $THWIP_TOKEN" \
  "https://thwip.recall.net/v1/queue/1315419165/explain?ref=refs%2Fheads%2Fmain" \
  | jq '[.mergeOperations[] | select(.outcome == null)] | length'
```
Expected: 0. This used to be a remote SQL statement against the live database;
`/explain` reports the merge writes now. See `docs/production-access.md`.

If it is still 5 after two ticks past the reset, the sweep has a defect that the
queue outage was masking. Read the heartbeat with
`pnpm exec wrangler tail --env staging --format pretty` and look for
`[queue heartbeat] orphaned merge write … is still unsettled:`, which names the
reason.

---

## Self-Review

**Spec coverage.** The two layers named in "The cause" both have a task: the
producer in Task 1, the consumer in Task 2. Task 3 proves the outcome against
the five open writes and three chain findings that motivated the work.

**Placeholder scan.** No TBDs. Every code step carries the code. The one place
that names a lookup rather than a literal, Task 2 Step 1's test harness, says
what to do if the consumer is not testable as it stands, rather than allowing
the task to be skipped.

**Type consistency.** `webhookWork` is defined in Task 1 and consumed by the
route in the same task; `WebhookWork.syncInstallation` is defined in Task 1 and
read by the consumer in Task 2. `MEMBERSHIP_EVENTS` and
`INSTALLATION_STATE_EVENTS` are exported once in Task 1 and imported in Task 2
and the tests. No name changes between tasks.

**One risk I want stated rather than hidden.** The predicate decides what never
reaches the consumer, so a mistake in it is silent: a dropped `pull_request`
event means a required check is never published and a pull request waits
forever, which is a worse failure than the cost being fixed. That is why Task 1
Step 1 requires reading the consumer first, why the test file covers each event
class the consumer acts on, and why Step 7 says a failing webhook test elsewhere
means the predicate is wrong rather than the test.
