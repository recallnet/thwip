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


## Candidate verification

Under the `fast` profile the evidence for a merge is the proof already on the
pull request head. That proof describes work done before the branch was
integrated, which is what `fast` says and all it says.

Under any stronger profile the queue claims the integration itself was run, and
it will not certify a merge until something has run it. The required suites
execute against the merge commit GitHub produced for the pull request, and the
verdict is stored against that commit's tree. A verdict for a different tree is
about different code and is never reused.

The verification runs from the default branch's copy of the workflow, in the base
branch's context, so a pull request cannot edit the thing that judges it. Only
the code under test comes from the candidate. The verdict's digest is computed
from its own content, so a result edited after the fact no longer matches it.

The queue verifies the integrated candidate before it certifies a merge.

A merge under a stronger profile carries a verdict bound to the tree that landed.
