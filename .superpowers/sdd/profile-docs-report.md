# fresh/audited docs no longer describe a refusal

## What was verified before writing anything

- `apps/control-plane/src/queue/assignment.ts`: `signLocalRunAssignment` builds
  and signs an `IntegrationAssignmentV1` for `mode: "run"` under `fresh` and
  `audited`. Implemented.
- `apps/control-plane/src/queue/integration-receipt.ts`:
  `acceptIntegrationReceipt` checks a submitted receipt against the issued
  assignment (assignment id and digest, candidate tree, device key, required
  suites). `apps/control-plane/src/queue/routes.ts` wires this into
  `POST /v1/queue/:repositoryId/receipt`, which verifies the JWS signature
  against the device's enrolled key before calling it. Implemented.
- `packages/cli/src/fresh-turn.ts`: `runFreshTurn` runs the full turn — fetch
  published keys, claim, verify the claimed assignment, materialize the
  candidate, run suites, sign and submit the receipt. Implemented.
- `audited` is `fresh` plus a second run, not another name for `fresh`.
  `packages/queue-protocol/src/merge-intent.ts` requires
  `["integration_receipt", "independent_dagger_rerun", "integration_verifier_result"]`
  for `audited`. `apps/control-plane/src/queue/candidate-verdict.ts`
  (`requiresRemoteVerification`) and its doc comment state it directly:
  "`audited` is `fresh` plus that second execution, so it wants both, and
  `remote` is the second execution alone." The merge is refused unless both
  the local receipt and the remote (Actions) verdict are present.

No code found that still refuses `fresh` or `audited` by profile name. Every
remaining "refuse" reference in the codebase is a genuine current refusal
(missing receipt, assignment mismatch, device mismatch, wrong tree), not the
retired "nothing is implemented yet" claim.

## Files changed

- `THWIP.md` (lines 47-62 region, "Which profile to choose"): replaced "Two
  profiles are available" / the refusal paragraph with a four-profile
  description. States what `fresh` does (signed assignment in, signed
  integration receipt out, checked against each other) and what it costs
  (a run on your machine, no Actions run). States `audited` as `fresh` plus
  a second independent Actions run of the same suites, with the merge
  withheld until both verdicts are in.
- `apps/control-plane/web/public/faq.md`: the "Which security profiles can I
  pick?" answer said "Two" and listed only `fast`/`remote`. Expanded to
  "Four" with `fresh`/`audited` descriptions matching THWIP.md. Removed the
  now-answered "The schema mentions fresh and audited. Can I use them? No,
  and the CLI refuses them..." question — its content is folded into the
  "Which security profiles" answer instead of standing as a separate,
  now-false Q&A.
- `apps/control-plane/web/public/llms.txt`: "Security profiles per project:
  fast ... and remote ... The schema also names fresh and audited; both are
  refused ... nothing issues one yet" rewritten to describe all four
  profiles as implemented.
- `apps/control-plane/web/src/App.tsx`: found a second, hand-duplicated copy
  of the FAQ hardcoded into the React page (not generated from `faq.md`).
  It carried the same "Two" / "No, and the CLI refuses them" text verbatim.
  Fixed to match the corrected FAQ content.

## Where the stale claim appeared

1. `THWIP.md`
2. `apps/control-plane/web/public/faq.md`
3. `apps/control-plane/web/public/llms.txt`
4. `apps/control-plane/web/src/App.tsx` (undiscoverable by grepping only
   `.md` files — this is JSX text, not markdown, and duplicates `faq.md`
   instead of rendering it)

`apps/blog/src/content/blog/beta.mdoc` was checked and already describes
`fresh`/`audited` correctly (a prior pass fixed it, per the task brief). No
change needed there.

## Anything left disagreeing

Nothing found. Everything the task asked me to verify against code matches
what the code does. One thing worth flagging for whoever owns the FAQ: the
static `faq.md`/`llms.txt` pair and the JSX in `App.tsx` are two independent
copies of the same content with no shared source. This doc pass fixed both,
but the next edit to one will silently skip the other unless someone
consolidates them.
