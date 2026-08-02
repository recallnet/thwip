# Uncalled code

## What was done

`apps/control-plane/src/queue/turn.ts` and its suite are gone, and a repository
check now fails when an exported value has no reference anywhere in shipping
code.

## The four flagged symbols

`finalGuard`, `decideMergeWrite` and `classifyMergeResponse` were three of six
symbols in `turn.ts` with no caller. The file planned an integration turn for a
Cloudflare Workflow driver; `driver.ts` went in PR 125 and the planner stayed.
`turnInstanceId`, `isValidEventName` and `planExecution` were in the same state.
The whole file is deleted.

### finalGuard

It reads as the safety check immediately before the write, so it was accounted
for check by check rather than dropped. Production performs eight of its eleven,
in three places.

| finalGuard check | where production does it |
| --- | --- |
| `BASE_MOVED` | `requireMergeable` in the reducer refuses a merge intent when `rebaselineRequired` |
| `QUEUE_PAUSED` | `requireMergeable`, when `paused` |
| `SUBJECT_TREE_MISMATCH` | `walkToMergeReady` refuses `CANDIDATE_CHANGED` and `INTEGRATION_RECEIPT_TREE_MISMATCH` |
| `ATTEMPT_REVISION_CHANGED` | `walkToMergeReady` re-reads `activeAttemptId` inside the transaction |
| `HEAD_MOVED` | the merge PUT carries the expected head, and GitHub answers 409 |
| `PR_CLOSED` | the merge workflow selects an open pull request; `/authorize` refuses a draft |
| `POLICY_CHANGED` | `decideCandidate` compares the stored verdict's policy digest |
| `REVIEWS_CHANGED` | `unsatisfiedRequiredChecks` before the ask, and GitHub's own refusal |

Three have no equivalent anywhere. `RULESET_DRIFT`, `APP_PERMISSION_DRIFT` and
`PERMISSION_REVOKED` are never re-read before a merge is authorized. Nothing
between a repository's ruleset being loosened and the queue merging onto it
notices.

They are not a separate omission. All three come from `deriveReadiness`, which
the new check reports as uncalled: `routes.ts` and `index.ts` each derive a
narrower readiness by hand, from the facts the caller supplied rather than from
GitHub. The careful ordering in `readiness.ts`, the ten reason codes and the
capability fold are dead. That is the same drift family as the receipt signing
bytes and the reason-code sentences, and it is recorded in the allowance list
rather than fixed here, because unpicking two hand-rolled copies is its own
change.

### decideMergeWrite

Deleted. Its rule is the reducer's now: `MergeRequested` refuses a second write
once `outcomeUnknown` is set, `beginMergeWrite` is idempotent, and the authorize
route hands back the operation id from the persisted `merge_operations` row
rather than deciding from a Workflow's step state.

### classifyMergeResponse

Deleted. `github-port.ts` classifies the response it sends, inside
`landMergeOnPinnedBase` and in `classify`. `turn.ts` held a third reading of the
same statuses returning a different shape, with no caller to keep it honest.
`MergeAttemptOutcome` moved to the file that uses it.

## The check

`scripts/uncalled-exports.mjs`, with `scripts/uncalled-exports.test.mjs`
alongside `worker-routes.test.ts`, `bundle-freshness.test.ts` and
`merge-literals.test.ts`. It parses every tracked `.ts`/`.tsx` file with the
TypeScript compiler API, builds each module's export map, resolves imports
through it, and reports exported values nothing reaches.

### What it tolerates, and why

- **Entry points**, read from what declares them: `main` in `wrangler.jsonc`,
  the esbuild entries in `scripts/build-npm.mjs` and the Action's build script,
  and the script tag in the web app's `index.html`. A hard-coded list would
  report the next Durable Object as dead on the day it is added.
- **A name its own module uses.** `evaluateAppProof` calls itself from a
  dispatcher eighty lines down; `checkInvariants` is called by the function
  below it. Those are 96 more findings, all of them saying only that a keyword
  is unnecessary, and they would bury the six that matter. Narrowing to "no
  reference anywhere, including its own file" is what makes the check readable:
  64 findings instead of 160.
- **Types and interfaces.** A type used structurally is used without ever being
  named in an import, so a name-based check cannot tell a spare one from one
  every value in the file is shaped by.
- **Test files and `test/` fixtures**, as findings. A helper two suites share is
  real use.
- **Barrels are followed, not counted.** `export * from "./x.js"` in a package
  index makes a name reachable under `@thwip/pkg`; it is not a use of it.
  Counting it as one is the failure mode of every off-the-shelf tool, and it
  would leave whole packages unchecked.

### What it deliberately does not tolerate

A test is not a caller. Every one of the historical cases had a thorough suite,
and counting suites as use is what let all of them pass review. Reach is counted
from shipping files only.

### The allowance list

`ALLOWED` in the test, one entry per symbol with a reason. It is checked both
ways: a finding that is not listed fails, and a listed symbol that is now used
fails as stale. So it can only shrink, and nothing joins it silently.

## Everything the check found

Fifty-eight, after the six in `turn.ts` were removed. Each is in `ALLOWED` with
a reason.

- `apps/control-plane/src/auth.cli.ts:10 auth`
- `apps/control-plane/src/github-events.ts:37 INTERNAL_QUEUE_EVENTS`
- `apps/control-plane/src/queue/bootstrap-workflows.ts:24 SETUP_BRANCH`
- `apps/control-plane/src/queue/bootstrap-workflows.ts:26 SETUP_PULL_REQUEST_TITLE`
- `apps/control-plane/src/queue/bootstrap-workflows.ts:503 setupPullRequestBody`
- `apps/control-plane/src/queue/bootstrap.ts:602 bootstrapGitHub`
- `apps/control-plane/src/queue/bootstrap.ts:569 handleBootstrapRequest`
- `apps/control-plane/src/queue/bootstrap.ts:701 OWNERSHIP_RULESET_NAME`
- `apps/control-plane/src/queue/candidate.ts:207 candidateFetchPlan`
- `apps/control-plane/src/queue/candidate.ts:101 candidateStillCurrent`
- `apps/control-plane/src/queue/commands.ts:52 validateTimings`
- `apps/control-plane/src/queue/evidence-store.ts:118 getEvidence`
- `apps/control-plane/src/queue/evidence.ts:461 reuseEquivalenceDigests`
- `apps/control-plane/src/queue/github-port.ts:521 classify`
- `apps/control-plane/src/queue/github-port.ts:428 dispatchVerifier`
- `apps/control-plane/src/queue/github-port.ts:249 landMergeOnPinnedBase`
- `apps/control-plane/src/queue/github-port.ts:183 mergePullRequest`
- `apps/control-plane/src/queue/github-port.ts:349 observeMergeResult`
- `apps/control-plane/src/queue/github-port.ts:497 readFinalGuardFacts`
- `apps/control-plane/src/queue/merge-commit.ts:72 mergeCommitText`
- `apps/control-plane/src/queue/projection.ts:227 projectionLag`
- `apps/control-plane/src/queue/readiness.ts:189 blockedOnlyByCapability`
- `apps/control-plane/src/queue/readiness.ts:156 deriveReadiness`
- `apps/control-plane/src/queue/readiness.ts:184 isKnownReason`
- `apps/control-plane/src/queue/rulesets.ts:361 isBootstrapCheck`
- `apps/control-plane/src/queue/runners.ts:20 HEARTBEAT_INTERVAL_SECONDS`
- `apps/control-plane/src/queue/runners.ts:51 SWEEP_INTERVAL_SECONDS`
- `apps/control-plane/src/queue/verifier-identity.ts:159 acceptCallback`
- `apps/control-plane/web/src/vocabulary.ts:166 BLOCKED_NEXT_ACTION`
- `packages/cli/src/config.ts:89 deriveConfig`
- `packages/cli/src/dagger.ts:42 ensureDagger`
- `packages/cli/src/dagger.ts:126 moduleDigest`
- `packages/cli/src/dagger.ts:76 requireContainerRuntime`
- `packages/cli/src/dagger.ts:101 runDaggerSuites`
- `packages/cli/src/pipeline.ts:14 parsePipelineDefinition`
- `packages/cli/src/pipeline.ts:27 pipelineDigest`
- `packages/cli/src/queue-commands.ts:405 isMutating`
- `packages/cli/src/queue-exit.ts:255 knownReasonCodes`
- `packages/cli/src/queue-exit.ts:34 LOCAL_REASONS`
- `packages/cli/src/queue-exit.ts:34 SERVICE_REASONS`
- `packages/cli/src/ship.ts:196 describeDecision`
- `packages/policy/src/index.ts:349 deriveProjectConfigFromText`
- `packages/prompts/src/queue.ts:141 hasQueuePointer`
- `packages/prompts/src/queue.ts:25 queueInstructions`
- `packages/prompts/src/queue.ts:148 queueSetupPrompt`
- `packages/prompts/src/queue.ts:123 withQueuePointer`
- `packages/queue-domain/src/invariants.ts:133 witnessDepth`
- `packages/queue-domain/src/reducer.ts:849 applyEvents`
- `packages/queue-protocol/src/integration-receipt.ts:321 parseExactReceiptReuse`
- `packages/queue-protocol/src/integration-receipt.ts:164 parseIntegrationReceipt`
- `packages/queue-protocol/src/integration-receipt.ts:277 receiptSatisfiesPolicy`
- `packages/queue-protocol/src/integration-receipt.ts:382 reuseEquivalenceHolds`
- `packages/queue-protocol/src/primitives.ts:127 bigintString`
- `packages/queue-protocol/src/primitives.ts:43 SUITE_NAME_RE`
- `packages/queue-protocol/src/queue-decision.ts:119 parseQueueDecision`
- `packages/queue-protocol/src/verifier-result.ts:234 parseVerifierResult`
- `packages/queue-protocol/src/verifier-result.ts:381 resultBindsAttempt`
- `packages/vocabulary/src/reason-codes.ts:89 reasonCodes`

## The one that stands out

`landMergeOnPinnedBase` writes a commit whose first parent is the pinned base
and moves the branch to it without `force`, so GitHub refuses when the base
moved. Its comment names pull requests 114, 117 and 119, each signed against one
base and merged onto another, each producing a tree no suite had run, all three
reported by GitHub as successes. Nothing calls it. Production merges through the
plain merge API in the workflow `bootstrap-workflows.ts` generates, which pins
the head and not the base, and relies on the queue having already observed the
external push to set `rebaselineRequired`. The stronger guarantee was written,
tested, and never connected.

## Verification

- `pnpm vitest run`: 118 files, 1771 tests, all passing. Baseline was 118 files
  and 1766 tests: `turn.test.ts` took 9 away and the new suite added 14.
- `pnpm typecheck`: clean.
- `node scripts/lint.mjs`: `lint: ok`.
