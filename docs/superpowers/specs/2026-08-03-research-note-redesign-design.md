# Research note redesign: attest the fixed point

**Date:** 2026-08-03
**Target:** `apps/blog/src/content/blog/beta.mdoc` (rewrite), plus supporting artifacts
**Status:** approved design, ready for planning

## Why the current note underwhelms

The existing post describes a system. Nothing in it required evidence we own,
and nothing in it takes a position somebody could argue with. Three concrete
defects:

1. **It cites the wrong literature.** Its related-work section is in-toto, DSSE,
   SLSA, Sigstore, Dagger, all of which predate the problem the post claims to
   address. The live 2026 conversation is execution provenance for LLM agents,
   and the post cites none of it.
2. **It has no measurements.** This repository holds 128 merged pull requests,
   156 signed proofs, 487 commits on `main`, and a signed merge record for every
   merge since the queue went live. The post uses none of that, and its one
   attempt at scale ("widely discussed as verification debt") is the
   unattributed industry-says construction the brief itself forbade.
3. **It buries its own thesis.** "thwip does not observe execution" sits in the
   limitations list as an apology. It is the design claim.

## The claim

thwip attests the fixed point of an agent's execution rather than the execution
itself.

The literature builds trust by reconstructing what the agent did.
[arXiv:2606.04990](https://arxiv.org/abs/2606.04990) defines execution
provenance as the typed graph of an agent execution and applies trust functions
to that graph. [arXiv:2607.05743](https://arxiv.org/abs/2607.05743) systematizes
39 papers from 2023 to 2026 into 17 categories covering sandbox isolation,
capability control, policy enforcement, TOCTOU races, and execution provenance,
and reports policy-enforcement failure rates between 69% and 98%.

thwip discards the trace. The in-toto subject is `git-tree` carrying a tree OID.
`packages/protocol/src/schema.ts:132` refuses any `evaluationMode` other than
`head-tree`, with the comment that a proof claiming to cover anything else is
not a proof. The App verifier executes no repository code (ADR 0001).

Two consequences follow, and both belong in the post:

- A trace is unfalsifiable at merge time. Nobody can replay an agent session to
  check a claim about it. A tree is falsifiable by anybody who checks it out and
  re-runs the suites.
- The TOCTOU category has no window here by construction. The object checked is
  an immutable content hash, and the whole class surfaces as one reason code,
  `SUBJECT_TREE_MISMATCH`.

## The line between research output and product post

The post must be worth reading and citing by somebody who will never install
thwip. The product appears as evidence that the claim is implementable. It does
not appear as an ask until the final block.

Four binding rules:

**R1. The install path leaves.** `beta-install.mdoc` is the product post. The
research note drops the `npm install -g` steps and both mid-body `cta-row`
blocks. One link block at the end.

**R2. Every artifact the post names is reachable and runnable.** The predicate
schema, the reason-code vocabulary (23 codes in
`packages/verifier/src/index.ts`), the transition-record format, and
`GET /v1/queue/records/:digest` all get direct links. Plus one new artifact
described below.

**R3. Two classes of number, never blended.** External citations carry a link
and a source name inline. Corpus measurements carry the method used to produce
them. A measurement that cannot be produced from the corpus is omitted rather
than estimated.

**R4. The attack that beats us goes in the body.** A compromised signing device
produces a valid proof over a tree whose suites never passed. The mitigation is
reproducibility plus a public chain, which is weaker than runtime observation
for any single merge and stronger across a sequence of them. That asymmetry is
stated plainly, including the case where it fails.

## Structure

1. **What changed in the workload.** Agent-authored pull requests moving from 4M
   to 17M in six months; GitHub at 275M commits per week; the ~2.7x vulnerability
   introduction rate for AI-generated code from
   [arXiv:2607.12428](https://arxiv.org/html/2607.12428v1); a worked example of
   CI spend under agent cadence. How a coding agent's loop produces this shape:
   many small pushes, each triggering a full re-run of a suite that already
   passed on the machine that wrote the code.
2. **The literature's answer, and its measured failure rate.** Observe and
   constrain the agent. The SoK's five cross-cutting gaps, with the
   policy-enforcement failure rates quoted.
3. **The claim.** Attest the fixed point. Why a tree is the falsifiable object
   and a trace is not. Where the TOCTOU window goes.
4. **The system as existence proof.** Carrier (`thwip-Proof` trailer, DSSE over
   in-toto Statement v1, predicate `urn:thwip:attestation:ci-run:v1`), subject,
   what the predicate actually carries including `networkMode` and `cacheMode`
   as declared posture rather than observed fact, the App verifier's trust
   boundary, the signed merge chain. Each paragraph links to the source file
   that implements it.
5. **Measurements from the corpus.** See below.
6. **What a proof does not buy.** Including R4's attack.
7. **Open problems**, separated into ones we intend to close (`fresh` and
   `audited` via assignment plus integration receipt, the `run.lease` field that
   already exists in the predicate for this purpose) and ones we do not know how
   to close (device compromise without observation; multi-party agreement on
   digests; hybrid matrices where part of the suite must stay remote).
8. **Repository and beta**, one block.

## Measurements to extract

Produced by a script committed alongside the post so a reader can rerun it.
Each is a figure or a table.

- **Proof coverage.** Commits on `main` carrying a `thwip-proof:` trailer, over
  time. Source: `git log`.
- **Reason-code distribution.** Which of the 23 codes have actually fired, and
  how often. Source: control-plane evaluation rows. If the rows are not
  extractable without production access, this becomes a static table of the code
  vocabulary with its semantics, and the post says so.
- **Merge-record chain.** Length of the chain on `main`, the distribution of
  record kinds (`verified-merge`, `reused-proof-merge`,
  `candidate-verified-merge`, `override-merge`, `base-correction`,
  `external-transition`, `genesis`), and the count of overrides. The override
  count is the honest one and is published whatever it says.
- **Actions minutes.** Minutes consumed on this repository versus minutes a
  full re-run-per-push policy would have consumed, with the counterfactual's
  method stated. Priced at GitHub's published per-minute rate, cited.

If any measurement turns out to be unavailable, it is dropped and its absence is
noted in the post. No estimates.

## New artifact: standalone chain re-verification

`packages/queue-protocol` already exports `verifyChain` and is tested
(`verify-chain.test.ts`). The gap is that no reader can run it.

Deliver a single script that takes a repository and a branch, fetches the
published records by digest, and runs the shipped `verifyChain` against them,
requiring no thwip account. Its output is the answer to "is this chain intact,"
and it is the concrete form of the falsifiability claim. The post links it and
states plainly that a reader who breaks our chain with it should open an issue.

## Figures

Novel, and each carries information the prose cannot:

- **F1. Trace versus fixed point.** The typed execution graph the literature
  attests, beside the single tree OID thwip attests, showing what is discarded.
- **F2. Where the TOCTOU window is.** The observe-and-constrain model's window
  between validation and use, and its absence when the subject is a content
  hash.
- **F3. Trust boundary.** Agent, device key, App, ruleset, with the pass/fail
  authority drawn as a boundary the agent sits outside.
- **F4. Corpus figure.** Whichever measurement above survives extraction, most
  likely proof coverage over time and record-kind distribution.

Figures ship as SVG in `apps/blog/public/blog/`, styled for the existing light
and dark treatment.

## Front matter and discoverability

- Title names the claim rather than the product.
- Description names execution provenance, commit-carried evidence, and the
  measurement.
- Tags gain `execution-provenance` and `research`.
- `updatedDate` bumped.
- Existing `BlogPosting` structured data retained. No invented affiliations.

## Editorial QA

- One content column; hero and body share edges.
- Tables styled with borders, header weight, readable padding. The existing
  table styles from `8f8d717` apply to the new tables.
- Code blocks readable, copy affordance where the site provides it.
- Prose passes `stop-slop`. No em dashes, no antithesis, no rule of three, no
  throat-clearing openers, no summary kicker.

## Out of scope

- Changes to `beta-install.mdoc` beyond whatever the moved install content
  requires.
- Any change to the thwip system itself. This is a writing and measurement task.
  If a measurement is blocked by a missing endpoint, the measurement is dropped
  rather than the endpoint built.
