# cli-failure-paths

Status: done. Worktree `/Users/devrel/Projects/_wt/recallnet/thwip/cli-failure-paths`, branch `cli-failure-paths`, based on `1511515` (main did not move during the work).

## Commits

| sha | subject |
| --- | --- |
| `4f7691a` | fix(cli): end a thrown failure with an exit class and a sentence |
| `e28095f` | fix(ship): finish the push the proof made non-fast-forward |
| `7fb414f` | fix(queue): let a member run doctor |
| tip | fix(queue): send the head sha join has always been refused for |

The tip's sha moves each time the proof is reattached, so it is named by subject. Opened as [PR 118](https://github.com/recallnet/thwip/pull/118). Each push carries a proof attached by `node packages/cli/dist/main.js run`.

## Tests

Before: 106 files, 1672 tests. After: 111 files, 1708 tests. Five new files, 36 new tests, nothing removed.

Red before, green after:

```
Error: Cannot find module './queue-doctor.js' imported from .../queue-doctor.test.ts
 Test Files  3 failed (3)
      Tests  no tests
```

```
 Test Files  111 passed (111)
      Tests  1708 passed (1708)
```

`pnpm typecheck` clean across every package. `node scripts/lint.mjs` prints `lint: ok`.

## Defect 1: the push

Reproduced first, exactly as reported. `thwip verify` in a directory that is not a repository was the cheapest instance of the same class:

```
Error: Command failed: git log -1 --format=%B
fatal: not a git repository (or any of the parent directories): .git
    at genericNodeError (node:internal/errors:998:15)
    ...
  code: 128, cmd: 'git log -1 --format=%B', stdout: '', stderr: '...'
EXIT=1
```

After:

```
thwip: fatal: not a git repository (or any of the parent directories): .git
Thwip stopped on a failure it has no reason code for. The line above is what failed; if it repeats, send it to whoever runs the queue.
EXIT=50
```

**The choice: ship forces, with a lease, only where it can prove it is undoing its own work.**

`git commit --amend` keeps the parents and changes the commit. A remote tip whose parents equal local HEAD's parents is therefore this branch's own previous tip and nothing else, so replacing it destroys nothing that was not already replaced. The force carries `--force-with-lease=refs/heads/<branch>:<that exact sha>`, so a push landing between the read and the write wins and ship loses.

Two guards on that:

- Different parents means somebody pushed on top. Ship stops with `PUSH_REJECTED` (exit 33, source changed) and the sentence "The remote branch holds a commit this machine does not have, so nothing was pushed. Fetch and rebase onto it, then run thwip ship again."
- A root commit is never forced. Two unrelated histories both have no parents, so the parent test proves nothing there.

The alternative, stopping and telling the developer to force by hand, hands them a git error for a divergence they did not create and that ship can describe exactly. Ship rewrote the commit; ship finishes the push.

Layers:

- `push-plan.ts` decides, from facts, with no repository.
- `git.ts` reads the two tips. The remote tip comes from `ls-remote`, because a remote-tracking ref is whatever the last fetch left behind. Its parents are read from this machine's object store, so a commit this machine has never seen resolves to `null` and cannot be forced over.
- `push-recovery.test.ts` runs the whole sequence against a real bare remote: push, amend, rejection, lease, and the same sequence with another clone's commit in the way.
- The push port reports a reason code rather than throwing, which is how every other step in the loop already reports.
- `cli-failure.ts` is the boundary. Every thrown value gets `LOCAL_FAILURE`, the invariant class, the line the command printed, and no frames. Registered for `unhandledRejection` too, because the interrupt handler runs detached.

## Defect 2: doctor

`thwip queue doctor` sent the developer's session to `/admin/queue/doctor`, which only an operator token opens.

Doctor now makes three reads and reports whatever it got:

1. `/v1/resolve-repo` — member. Is thwip installed here.
2. `/v1/queue/{id}/explain` — member. What the queue is doing on this branch, per entry, with the blocking reason rendered through the shared sentence table rather than quoted as a bare code.
3. `/v1/queue/{id}/doctor` — repository admin. App permissions and rulesets.

For a non-admin the third is refused, doctor names it as unread, prints the other two, and exits 0. `--strict` turns an unread section into exit 11 for a setup script that needs the whole picture. The admin section is admin-only for a real reason: it reads GitHub under the installation.

Live against production, as an admin:

```
thwip is installed on recallnet/thwip (repository 1315419165).
The queue for refs/heads/main is running, with 2 waiting and one holding the lane.
  #114 Reconciling: nothing is holding it.
  #116 Deferred: nothing is holding it.
The Thwip App holds every permission the queue needs.
1 ruleset applies to this repository.
EXIT=0
```

Two output bugs were caught by running it live and fixed with tests: merged and cancelled entries were counted as waiting (twenty-two of them, against two live entries), and "1 ruleset apply".

## Defect 3: `thwip queue join` has never worked

Handed over mid-task by the agent on PR 119. Confirmed against main, not taken on trust: the route has required `headSha` since it was written, `join` has never sent one, so every `thwip queue join` anybody ran was answered 400. It also sent `sponsorLogin`, which no version of the route has ever read.

Fixed in the CLI, coded against the route as PR 119 leaves it (read from `origin/queue-routes-fixes`, since 119 had not landed):

- `join` sends `headSha`. The head of the pull request being queued is read from GitHub with `gh pr view <n> --repo <owner/name> --json headRefOid`, not from this machine's HEAD, because the pull request named on the command line is often not the branch checked out here. `--head-sha OID` overrides it and is validated as an object id.
- `--sponsor` is gone. PR 119 derives the sponsor from the pull request's author, because the same pull request queued through the route and through the webhook was producing two entries with two different sponsors. Passing `--sponsor` now gets "--sponsor is no longer accepted; the pull request's author sponsors it" and exit 2, rather than the generic unknown-flag message.

Live against production, where it used to return 400:

```
$ thwip queue join --repo recallnet/thwip --pr 118 --branch main
{"entryId":"entry_1315419165_118","result":{"status":"duplicate",...}}
EXIT=0
```

### Why nothing noticed

Both sides were tested against themselves. `queue-commands.test.ts` asserts the body the planner builds, written beside the planner. The route's tests post a body the route's own tests compose. Each half stayed correct against its own idea of the wire for as long as it existed, which is exactly the arrangement that lets two correct halves disagree.

It is the same shape as the doctor defect in this branch: a plan asserted against expectations written next to it and never against the server that answers it. And the same shape as the drift `one-vocabulary.test.ts` was written to catch, where three surfaces each held a correct copy of a sentence and the copies came apart.

Two other things kept it invisible. Ship's own `joinQueue` port builds its request by hand and has always sent `headSha`, so the path most people are on worked and the standalone command was the only broken one. And the command's failure was a 400 body printed to stdout with a non-zero exit, which reads like a queue that refused you rather than a client that cannot form a request.

`one-wire.test.ts` is the missing half. It reads `apps/control-plane/src/queue/routes.ts` as source, extracts what the entries handler declares it will read and what it refuses the request for missing, and holds the CLI's plan against both. It fails if the CLI sends a field the route ignores, or omits one the route demands. It also asserts the handler still declares a body at all, so a rewrite cannot make it pass by finding nothing.

## Reconciling with PR 116

PR 116 (`ship-announces-presence`) was open and unmerged throughout. It adds an `announcePresence` port to `ShipPorts` and a call site in the `runShip` loop. This branch changes the `push` port's return type in the same interface and the `push` case in `perform`. Different lines, no overlap in the loop body. Whichever lands second takes a two-line textual conflict at most in `ship-io.ts`, and both changes are additive to the same interface.

## Vocabulary

Two codes added to `LOCAL_REASONS` in `packages/vocabulary`, with sentences in the shared table and exit classes in `queue-exit.ts`:

- `PUSH_REJECTED` → exit 33, source changed.
- `LOCAL_FAILURE` → exit 50, invariant.
