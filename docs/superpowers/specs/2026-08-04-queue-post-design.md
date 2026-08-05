# Second research post: the merge queue at agent cadence

**Date:** 2026-08-04
**Target:** a new post in `apps/blog/src/content/blog/`
**Status:** structure approved, ready to write

## Audience

A team of engineers on one shared repository, each running their own coding
agent. Not supply-chain researchers. They already feel the pain and want to know
whether this fixes it.

## Thesis

Everyone's agent works in parallel until the merge. The queue is the one piece of
shared infrastructure every change has to pass through, and it is the only serial
thing in an otherwise parallel setup. Traditional queues re-verify the integrated
candidate in the cloud, so each merge costs a full CI run in series, and six
agents behind that is a line rather than a queue.

thwip's queue merges on evidence that already exists, or on a run performed on a
developer's own machine, so the line moves in seconds.

The load-bearing idea, and section 4 should build to it: neither half works
alone. Edge CI with a signature gives you a verified head, and the head is not
the tree that lands. A queue on its own binds the tree that lands and still pays
the cloud to prove it again. Put them together and the queue pins the candidate
while the signature is what lets it accept a run nobody watched. That pairing is
why a merge can be seconds long and still be about the code that actually
merged.

The first post's chain and signing appear here in service of that, not as the
subject.

## Structure

1. **Where a shared repo jams.** Parallel until the merge. Xu, Subramanian and
   Karthik: 79.4% of agent-authored pull requests overlap in time with another on
   the same repository, and 41.7% of cross-agent pairs conflict textually. That
   is the queue's inbox.
2. **Why a queue exists at all.** The branch that passed is not the tree that
   lands. General point, not a thwip one, and the reason serializing exists.
3. **Why the queue became the bottleneck.** Re-verifying the candidate in the
   cloud, in series. Bouzenia and Pradel's 6.3 minutes mean VM time per job is
   the number to reach for.
4. **How this one moves.** One lane, the candidate pinned, and what it merges on
   at each setting. `fast` merges on the proof the head carries. `fresh` runs the
   integrated candidate on the developer's machine. Neither spends a cloud run.
5. **What an agent can see.** Position, state and reason as codes rather than
   prose, from one authenticated call. The status comment. The record fetchable
   by digest.
6. **What it refuses.** Fail closed. It will not sign a record citing something
   it could not read.

## Verify before writing

Every mechanism claim comes from the code, not from the first post and not from
this document. The first post shipped with a fabricated author attribution, a
misattributed statistic, a wrong trailer name and a wrong reason-code count,
each corrected only because somebody checked. Read the source:

- `packages/queue-protocol/src/transition-record.ts` for what a record cites and
  the seven kinds.
- `packages/queue-domain/src/scheduler.ts` and the reducer for how a lane is
  offered and what makes an entry eligible.
- `apps/control-plane/src/queue/candidate.ts` for what pinning a candidate
  rejects, including the first-parent check.
- `apps/control-plane/src/queue/authorize-turn.ts` for the walk to a merge.
- `packages/policy` for the four profiles and `requiresIntegratedRun`.
- `packages/vocabulary` for reason codes. Count them rather than quoting a count.

## Do not claim

- Token churn or CI dollar savings for anybody's repository. There is no data.
- Anything about `remote` or `audited` working for adopters before 4 August.
  `queue_projects.verifier_json` had no writer, so both refused every merge with
  `NO_PINNED_VERIFIER`. Fixed, and not something to write around.
- That the queue has no defects. It had four unrecorded merges on 2 August.

## Do not repeat

The first post carries the incident where the chain checker found four
unrecorded merges. It belongs there and nowhere else. This post does not retell
it, does not allude to it as evidence of honesty, and does not use the words
honest, candid, or transparent about itself. If a limit matters, state the limit.

## Voice

Every rule from the first post's edit, in full:

no antithesis, no corrective negation, no paragraph pinning, no parataxis, no
summary beats, no rhetorical crutches, no negative parallelisms, no negative
anaphoras, no contrasting pairs, no rule of three, no em dashes, no
throat-clearing openers, no landing sentences, no setup and payoff, no parallel
sentence structures inside a paragraph, vary sentence length unpredictably, no
stacked noun phrases, no filler intensifiers, no corporate-register verbs, no
nominalization, no hedging qualifiers, write for the spoken voice, no performed
enthusiasm.

Two that kept slipping through on the first post and want checking one rule at a
time rather than in a single pass: sentences aimed at the reader's attention
rather than at the subject ("the thing to notice", "what matters is"), and
sentences announcing a virtue the page could simply have ("this arithmetic is
open to anybody who wants to redo it").

## Form

Tables where numbers want comparing, split by what they measure rather than one
grid. Figures only where they carry something prose cannot. Match the existing
post's palette: `--paper #ffffff`, `--ink #1b1b1b`, `--civic #005ea2`,
`--muted #565c65`, `--rule #dfe1e2`.

Title names the reader's problem or the claim, in the register that does well on
Hacker News: short, flat, no cleverness. "LLMs reward expertise". "Why Large
Language Models Fail at Tabular Prediction".
