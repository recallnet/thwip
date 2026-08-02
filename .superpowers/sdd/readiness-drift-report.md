# Three checks that existed, were tested, and were not in the path

`RULESET_DRIFT`, `APP_PERMISSION_DRIFT` and `PERMISSION_REVOKED` each have a
reason code, a sentence agreed across the check, the CLI and the dashboard, and a
test. Nothing consulted any of them at the moment a merge was authorized.

## The two hand-rolled derivations

`deriveReadiness` (apps/control-plane/src/queue/readiness.ts) collects twenty
blocking reasons in a deliberate order. The uncalled-export check added in PR 126
reported it as having no caller, and the allowance entry said so in as many
words.

The two places that decide readiness instead:

- `/authorize` in apps/control-plane/src/queue/routes.ts:

      const baseReady = body.proofAccepted === true && body.draft !== true;
      const basePrimaryReason =
        body.draft === true ? "PR_DRAFT" : body.proofAccepted === true ? null : "LOCAL_RECEIPT_MISSING";

  Two facts, two reasons.

- `queueFromPullRequest` in apps/control-plane/src/index.ts:

      const ready = !draft && open;
      const basePrimaryReason = draft ? "PR_DRAFT" : !open ? "PR_CLOSED" : null;

  Two facts, two reasons, and a different two.

Both then call `foldCapability`, which is the one thing they did share. Between
them they consulted five of the twenty checks. The branch ruleset, the App's
permissions and the sponsor's repository access were in neither.

## Deliberate or omitted

Omitted. Three pieces of evidence.

1. No fact source exists for any of them. `appPermissionsHealthy` and
   `rulesetEnforced` appear in exactly four places in the repository: the
   `ReadinessFacts` fields, the two lines of `collect` that read them, and the
   test table. No producer, in D1 or from GitHub, ever computed either one. A
   deliberate omission leaves a fact that somebody chose not to consult; this
   left a field nobody could fill.
2. The allowance in scripts/uncalled-exports.test.mjs describes the state and
   defers it: "`routes.ts` and `index.ts` each derive a narrower readiness by
   hand. That is the drift this check exists to find, and unpicking it is its own
   change." That is a known gap, not a decision that the checks are unwanted.
3. The vocabulary carries all three, end to end. `nextActionFor` has a sentence
   for each, `queue-exit.ts` maps each to an exit code, and one-vocabulary.test
   holds the three surfaces against each other for every blocking reason. Nobody
   builds that for a reason they have decided not to raise.

## The one already checked under another name

`PERMISSION_REVOKED` is not a readiness reason. It is an attempt outcome, and
packages/queue-domain/src/reducer.ts maps it to `blocked("OWNER_UNAUTHORIZED")`
with a comment explaining why: the sponsor's own access is a different problem
from the App missing a scope, and reporting one as the other sends an
administrator to reinstall an App that is installed correctly.

So there are two readiness facts and one attempt outcome, and the readiness fact
behind the outcome is `ownerAuthorized`. The queue does check organization
membership on every `/v1/queue/*` route through `mayActOnRepository`
(apps/control-plane/src/queue/repository-access.ts), but that answers whether the
caller belongs to the organization that owns the repository, not whether the
sponsor holds the repository permission the policy requires. Being in the
organization and being able to write to the branch are different grants, and the
projection keeps them in different tables. The check was genuinely absent.

The projection does carry the answer. `repository_grants` holds effective
collaborator permission per repository, refreshed by installation sync. It is not
read here on purpose: a revocation the projection has not caught up with is
exactly the case this guard exists for, and answering from a copy that lags
GitHub would leave the hole open for as long as the lag.

## The fix

One derivation, three call sites.

`deriveReadiness` gains `NO_OBJECTION`: a complete `ReadinessFacts` where every
value means "no objection". A caller spreads it and overrides what it has read.
That is what makes one derivation usable from a place that holds two facts, and
it is the alternative to a third narrow copy. Every default is permissive because
an unread fact is not a refusal; a blank that blocked would stop the queue on
everything nobody had got round to reading.

- `/authorize` derives its base readiness through `deriveReadiness`, then folds
  capability as before.
- `queueFromPullRequest` does the same from `draft` and `state`.
- On the walk to a merge, `/authorize` reads `platformHealth` and derives again
  from the three facts. A refusal names `stillHolds.primaryReason` and takes its
  sentence from `nextAction`, so no fourth copy of the wording is written.

One behaviour changed. A pull request that is both draft and closed now reports
`PR_CLOSED` where the webhook used to say `PR_DRAFT`, because `collect` orders
closed before draft. The closed action is handled earlier in the same function,
so this is reachable only on a synchronize event for an already-closed draft, and
closed is the more actionable of the two.

## What it costs

Three GitHub reads per merge, and none on the ask a waiting pull request repeats.

The guard sits inside the `prepare === true && walkable` branch, beside the
required-check read that is already there. That branch runs once, for the caller
that is about to write the merge. The `/authorize` route itself is a required
check: every pull request in the queue calls it on every workflow run, and adding
reads there would have multiplied by the depth of the queue and by every retry.

| Read | Answers |
| --- | --- |
| `GET /repos/{repo}/rules/branches/{branch}` | are `thwip` and `thwip / turn` still required, and are force-push and deletion still refused |
| `GET /repos/{repo}/collaborators/{login}/permission` | may the sponsor still write here |
| `GET /app/installations` (via `listInstallations`) | does the App still hold contents, pull_requests and checks at write |

Plus two D1 row reads, for the project row and the sponsor's login.

The rules endpoint is read twice on this path, once here and once by
`requiredCheckState` moments later. The duplicate stands rather than threading a
cache across the dependency boundary: one read per merge against an hourly budget
this account uses a fraction of is cheaper than a second cached shape that can go
stale. On this deployment's volume, a merge every few minutes at peak, three
reads per merge is under one percent of the installation's hourly allowance.

`actions` is deliberately not among the permissions checked. A verifier that
cannot be dispatched stops the attempt long before the merge guard, and refusing
here would name the wrong problem.

Every unreadable answer returns null and the merge proceeds. Refusing a merge
because GitHub had a bad minute would stop the queue for everyone, which is the
worse of the two failures and the same trade `requiredCheckState` makes.

## Verification

- New tests: 4 of 7 failing before, all 7 passing after.
- `pnpm vitest run`: 118 files / 1771 tests before, 119 files / 1780 tests after.
- `pnpm typecheck`: clean.
- `node scripts/lint.mjs`: ok.
