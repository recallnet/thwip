# Agent Merge Queue Homepage Design

## Goal

Make the homepage sell Thwip Queue as the merge system for teams that run many
coding agents. The page should start with the CI work agents already perform in
their own checkouts, then show how the queue reuses that work to move a
protected branch without a cloud CI run per merge.

## Reader and conversion

The reader owns a repository and its protected branch. They need to understand
the operating loop before they care about proof format or policy internals.
The primary action sends them into the authenticated dashboard flow that starts
repository setup. Developer machine setup remains an install-page concern.

## Message hierarchy

1. Agents test branches in parallel before they create pull requests.
2. Thwip carries those results into a protected merge lane rather than throwing
   them away and rebuilding CI in series.
3. Fast reuses the pull-request proof. Fresh runs the pinned candidate on the
   device that claims the turn. Remote and Audited add GitHub execution.
4. The GitHub App owns the protected-branch write and records why each merge
   passed.

The page must use the existing operating measurements as proof: 14.0 seconds
for a Fast turn-to-merge median on Thwip, 28.0 seconds from Fresh assignment to
signed merge record on thwip-test, and 73 seconds for the Thwip cloud candidate
verifier. Each metric names its repository and sample size.

## Structure

```
hero: thesis + dashboard CTA + three operating measurements
parallel-work section: agent checkouts feed a merge lane
profile section: Fast, Fresh, Remote, Audited as one policy continuum
queue-control section: pinning, reasoned blocks, App branch writer
evidence section: signed record as supporting proof
setup section: repository setup CTA
```

## Visual direction

Keep the existing paper, ink, civic-blue notary system. Replace the replayed
terminal with a queue diagram built from the page's own typography: parallel
agent rows meet at one protected merge lane. The diagram is the page's single
distinctive visual device. Measurements remain dense editorial data, not
marketing counters.

## Boundaries

- Do not claim customer savings or a conflict-reduction rate.
- Do state the real operating measurements and link to the research post.
- Do not lead with signature formats, DSSE, or verifier reason-code tables.
- Do state Fast's reuse model and Fresh's candidate-run model accurately.
