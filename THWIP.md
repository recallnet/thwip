
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
