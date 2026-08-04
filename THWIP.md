## What a merge record cites

The queue records the digest of the proof on the pull request head — the one you
signed, taken over the exact bytes the commit carries. A head whose proof cannot
be read does not merge, because a merge record that cites nothing is worse than
no record.

## What a chain link is

Each merge adds a link to the branch's chain. A link is the digest of a record
the queue signed, and `GET /v1/queue/records/:digest` returns the exact bytes it
signed, so you can check a merge instead of taking the dashboard's word for it.

A record says which kind of merge it was, and the kinds are not interchangeable.
A merge the queue had verified against the integrated candidate cites that
verifier's result. A merge accepted on the head's own proof cites no verifier
result at all, because none ran. Neither cites an assignment, because the queue
dispatches its verifier rather than assigning work to it.

If the queue cannot read one of the things a record cites, it refuses the merge
rather than signing a record with a gap in it.

## The three checks you will see

`thwip` and `thwip / turn` are required and decide whether a merge happens.
`thwip / candidate` is not required: it reports what the required suites did
against the integrated candidate, which is a different tree from your head.

All three are published by the thwip App, so what you see on a pull request is
what the queue used to decide.

## The two required checks

`thwip` says the proof is good for this exact tree. `thwip / turn` says it is
this pull request's turn to merge.

The first is a fact about the commit and holds until the commit changes. The
second moves every time the queue offers the lane to somebody else, so while a
pull request waits its turn check sits in progress rather than failing. Waiting
is not a failure, and a failed required check goes on refusing the merge after
the queue has authorized it.

The queue publishes the turn check itself when it offers the lane. Nothing needs
re-running.


## Which profile to choose

Four profiles are available.

`fast` merges on the proof already carried by the pull request head. That proof
describes work done before the branch was integrated, which is what `fast` says
and all it says.

`remote` runs the required suites in GitHub Actions against the merge candidate
and merges on that verdict. It costs a CI run per merge; `fast` costs none.

`fresh` runs the required suites on the developer's own machine. The queue
issues that machine a signed assignment naming the candidate tree and the
suites it must run, and the machine answers with an integration receipt,
signed on the same machine, naming what it ran and against what tree. The
queue checks the receipt against the assignment before it counts as evidence.
`fresh` costs a run on your own machine and buys a merge without spending an
Actions run.

`audited` is `fresh` plus a second run: the same suites execute again in
GitHub Actions against the same candidate, and the queue withholds the merge
until it holds both the local receipt and that remote verdict. It costs what
`fresh` costs plus what `remote` costs, and buys agreement between a run you
controlled and one you didn't.

## Candidate verification

Under `remote` the queue claims the integration itself was run, and
it will not certify a merge until something has run it. The required suites
execute against the merge commit GitHub produced for the pull request, and the
verdict is stored against that commit's tree. A verdict for a different tree is
about different code and is never reused.

The verification runs from the default branch's copy of the workflow, in the base
branch's context, so a pull request cannot edit the thing that judges it. Only
the code under test comes from the candidate. The verdict's digest is computed
from its own content, so a result edited after the fact no longer matches it.

The queue verifies the integrated candidate before it certifies a merge.

A merge under `remote` carries a verdict bound to the tree that landed.
