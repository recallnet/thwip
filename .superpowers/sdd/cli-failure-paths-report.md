# cli-failure-paths

Status: done. Worktree `/Users/devrel/Projects/_wt/recallnet/thwip/cli-failure-paths`, branch `cli-failure-paths`, based on `1511515` (main did not move during the work).

## Commits

| sha | subject |
| --- | --- |
| `4f7691a` | fix(cli): end a thrown failure with an exit class and a sentence |
| `e28095f` | fix(ship): finish the push the proof made non-fast-forward |
| `3cd06fb` | fix(queue): let a member run doctor |

Opened as [PR 118](https://github.com/recallnet/thwip/pull/118), with a proof attached by `node packages/cli/dist/main.js run`.

## Tests

Before: 106 files, 1672 tests. After: 110 files, 1702 tests. Four new files, 30 new tests, nothing removed.

Red before, green after:

```
Error: Cannot find module './queue-doctor.js' imported from .../queue-doctor.test.ts
 Test Files  3 failed (3)
      Tests  no tests
```

```
 Test Files  110 passed (110)
      Tests  1702 passed (1702)
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

## Reconciling with PR 116

PR 116 (`ship-announces-presence`) was open and unmerged throughout. It adds an `announcePresence` port to `ShipPorts` and a call site in the `runShip` loop. This branch changes the `push` port's return type in the same interface and the `push` case in `perform`. Different lines, no overlap in the loop body. Whichever lands second takes a two-line textual conflict at most in `ship-io.ts`, and both changes are additive to the same interface.

## Vocabulary

Two codes added to `LOCAL_REASONS` in `packages/vocabulary`, with sentences in the shared table and exit classes in `queue-exit.ts`:

- `PUSH_REJECTED` → exit 33, source changed.
- `LOCAL_FAILURE` → exit 50, invariant.
