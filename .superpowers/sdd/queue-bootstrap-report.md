# Queue bootstrap

## What the required check contexts actually are

`policyRuleset()` pinned `Thwip / Merge`. Nothing publishes it.

Evidence, in the order I gathered it:

1. `gh api repos/recallnet/thwip/rulesets/19927569` — the one active ruleset on the
   repository that runs the queue. Its `required_status_checks` are
   `{"context":"thwip","integration_id":15368}` and
   `{"context":"thwip / turn","integration_id":4419870}`. Nothing named
   `Thwip / Merge`.
2. `gh api repos/recallnet/thwip/commits/<PR 94 head>/check-runs` — every check run on a
   real pull request head: `thwip`, `thwip / lint`, `thwip / test`, `thwip / typecheck`
   from app 15368 (`github-actions`), and `thwip / candidate`, `thwip / turn` from app
   4419870 (`thwip-dev`). Again nothing named `Thwip / Merge`.
3. `.github/workflows/thwip-required.yml` is `name: thwip` with a job `thwip` named
   `thwip`, so the proof check is published by a workflow and GitHub attributes it to
   Actions. `apps/control-plane/src/queue/turn-check.ts` declares `TURN_CHECK =
   "thwip / turn"` and `apps/control-plane/src/index.ts:1952-1981` is what POSTs it, as
   the App.
4. `Thwip / Merge` is built by `buildCheck` in `check.ts`, called only from `driver.ts`,
   which is imported by nothing. `publishMergeCheck` in `github-port.ts` is likewise
   uncalled. The context is dead code all the way down.

So there are two publishers and therefore two sources. `policyRuleset()` now emits
`{context: "thwip", integration_id: GITHUB_ACTIONS_INTEGRATION_ID}` and
`{context: "thwip / turn", integration_id: <the App>}`. One shared `integration_id`
would have made one of them unsatisfiable.

`bootstrapCheckRun()` now names `thwip / turn`. GitHub only offers an App as the
expected source of a context the App has recently posted, and the App posts the turn
check. The proof check gets its source the ordinary way: the setup pull request adds
the workflow and the workflow runs, which is exactly why `merge-setup-pr` is first.

`THWIP_MERGE_CONTEXT` stays exported because `check.ts` and `github-port.ts` name it.
It is required by nothing. Removing the dead check path is a separate change in files
another agent holds.

## What was built

- `apps/control-plane/src/queue/bootstrap-workflows.ts` — the setup pull request's
  files. This repository's own `thwip-required.yml` and `thwip-merge.yml`, with the
  published action in place of the `uses: ./` only this repository can use, plus a
  default `thwip.yaml`. A drift test compares names and triggers against the originals.
- `apps/control-plane/src/queue/bootstrap.ts` — enrolment and the step engine.
  `enrollQueueProject` writes the `queue_projects` row, taking the organization from
  `projects` rather than from the caller. `advanceBootstrap` performs exactly one of
  `BOOTSTRAP_STEPS` and records it. `runBootstrap` walks until it waits or refuses.
  `handleBootstrapRequest` does both in one call. `bootstrapGitHub` is the port against
  a real repository.

`BOOTSTRAP_STEPS` and `mayActivate` are used as written. They were correct; they had no
caller. `mayActivate` gates `activate-policy-and-ownership`.

Each step, and what it refuses on:

| Step | Does | Refuses when |
|---|---|---|
| `merge-setup-pr` | Opens the setup PR, waits for a human to merge it | never; waits |
| `create-disabled-policy-without-source` | Creates the policy disabled, both contexts unpinned | the diff would drop an existing control |
| `publish-bootstrap-check` | App posts a neutral `thwip / turn` on the base sha | the policy is not disabled, or GitHub attributed the check to another integration |
| `attach-integration-id-while-disabled` | PUTs both pins, still disabled | the policy is already enforcing |
| `canary-negative-test` | Re-reads the ruleset and checks GitHub kept both pins | GitHub stored a different source, or none |
| `activate-policy-and-ownership` | Enforcement on, plus ownership (managed) or merge_queue (native) | `mayActivate` says a step is missing, or the rule is for the wrong backend |
| `record-genesis` | `enabled = 1`, `activation_state = 'observe'` | never |

## Where this diverges from plan.md §44.3

§44.3 step 5 wants a temporary canary target: a ref, a pull request, and a rule created
on the owner's repository, proving a same-named Actions check cannot satisfy an
App-pinned rule and then removed. That mutates somebody's repository for a test and
needs its own authorization, so it is not done here. What is done is the half that
needs nothing: read the ruleset back and confirm GitHub stored the sources it was sent.
A payload GitHub accepts while dropping the pin leaves a context any workflow can
satisfy, and activating on what was sent rather than on what was kept is how that goes
unnoticed. The gap is named in the code.

## Still manual after this

`THWIP_ENQUEUE_TOKEN`. The merge workflow reads it as a repository secret and declines
cleanly without one, leaving the merge to a maintainer. Writing it needs a credential
decision, not a bootstrap step. No SQL is manual.

## Wiring routes.ts needs

Three additions, none of which touch an existing line.

1. Imports, alongside the others at the top:

```ts
import {
  bootstrapGitHub,
  bootstrapStatus,
  handleBootstrapRequest,
  readQueueProject,
} from "./bootstrap.js";
import { SETUP_BRANCH, SETUP_PULL_REQUEST_TITLE, setupPullRequestBody } from "./bootstrap-workflows.js";
import { githubHttp } from "./github-port.js";
```

2. Two fields on `QueueRouteEnv`, which `index.ts` already has in `Env`:

```ts
readonly GITHUB_APP_ID: string;
```

and two dependencies on `queueRoutes`'s `deps`, because the queue layer holds no App
credentials of its own:

```ts
/** An installation token for the repository, and the name it is known by. */
repositoryToken(env: TEnv, repositoryId: string): Promise<{ token: string; fullName: string } | null>;
/** The action reference the generated workflows should call. */
setupActionRef(env: TEnv): string;
```

3. The two routes. `bootstrap` is not in `REPOSITORY_ACCESS`, so it defaults to
   `member` and the existing gate authenticates it; `isAdmin` is read after, the way
   `pause` does.

```ts
app.post("/v1/queue/:repositoryId/bootstrap", async (c) => {
  const selected = requestedQueue(c);
  if ("error" in selected) return c.json({ error: selected.error }, 400);
  const { repositoryId, baseRef } = selected;

  const who = c.get("caller");
  if (!who.isAdmin) return c.json({ error: "repository admin required" }, 403);

  const access = await deps.repositoryToken(c.env, repositoryId);
  if (access === null) return c.json({ error: "the Thwip App is not installed on this repository" }, 404);
  const [owner, repo] = access.fullName.split("/");
  if (owner === undefined || repo === undefined) return c.json({ error: "unreadable repository name" }, 500);

  const body = (await c.req.json().catch(() => ({}))) as {
    backend?: "managed" | "native";
    mergeMethod?: "merge" | "squash";
    requiredApprovingReviewCount?: number;
    requireCodeOwnerReview?: boolean;
  };

  const endpoint = c.env.PUBLIC_ORIGIN;
  const response = await handleBootstrapRequest({
    db: c.env.DB as unknown as D1Like,
    github: bootstrapGitHub(githubHttp(access.token), { owner, repo, baseRef }, {
      branch: SETUP_BRANCH,
      title: SETUP_PULL_REQUEST_TITLE,
      body: setupPullRequestBody({ endpoint, actionRef: deps.setupActionRef(c.env) }),
    }),
    integrationId: Number(c.env.GITHUB_APP_ID),
    endpoint,
    actionRef: deps.setupActionRef(c.env),
    review: {
      requiredApprovingReviewCount: body.requiredApprovingReviewCount ?? 1,
      requireCodeOwnerReview: body.requireCodeOwnerReview ?? false,
    },
    repositoryId,
    baseRef,
    ...(body.backend === undefined ? {} : { backend: body.backend }),
    ...(body.mergeMethod === undefined ? {} : { mergeMethod: body.mergeMethod }),
  });
  return c.json(response.body as Record<string, unknown>, response.status as 200);
});

app.get("/v1/queue/:repositoryId/bootstrap", async (c) => {
  const selected = requestedQueue(c);
  if ("error" in selected) return c.json({ error: selected.error }, 400);
  const { repositoryId, baseRef } = selected;

  const project = await readQueueProject(c.env.DB as unknown as D1Like, repositoryId, baseRef);
  if (project === null) return c.json({ error: "this repository is not enrolled" }, 404);
  return c.json(bootstrapStatus(project));
});
```

`index.ts` supplies `repositoryToken` from what it already does at
`index.ts:1651-1658` — `SELECT p.github_name, o.installation_id FROM projects p JOIN
organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?`, then
`installationToken(env, installation_id)` — and `setupActionRef` from the release tag
the action is published under.

`GITHUB_APP_ID` is the App's Integration id: it is the JWT issuer in
`github-app.ts:13`, and it is the same number GitHub reports as `app.id` on the check
runs the App publishes (4419870 on the dev App). `publish-bootstrap-check` compares the
two and refuses if they disagree, so a wrong value fails before anything is pinned.

## Verification

- `pnpm vitest run`: 106 files, 1672 tests, all passing. Baseline on main was 104 files,
  1639 tests.
- `pnpm typecheck`: clean.
- `node scripts/lint.mjs`: `lint: ok`.
