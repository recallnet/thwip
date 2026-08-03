# Deviations from plan.md in the v1 vertical slice

This build implements the plan's Phase 0 + Phase 1 vertical slice plus the
merge-queue end state. Where the slice deviates from the full specification,
the deviation and the reason are recorded here.

## Protocol and verifier

- **Hand-rolled strict validators instead of Effect Schema.** The plan asks
  for Effect Schema at every boundary but also requires the protocol and
  verifier packages to stay dependency-light so the same bytes run in the
  CLI, the bundled Action, and tests. The slice keeps `@thwip/protocol` and
  `@thwip/verifier` zero-dependency (plus `canonicalize` for RFC 8785) with
  strict, fail-closed hand-written parsers. Effect can be layered into the
  Worker later without touching the protocol.
- **`pipeline` predicate field replaces the `dagger` field.** The slice binds
  a `pipeline.digest` + `runner` (`command` | `dagger`) instead of Dagger
  module/engine/image digests. See "Dagger" below.
- **Lease JWS validation is wired but not exercised** — the thwip project
  runs the Fast profile (`lease.required: false`). The lease issuance
  endpoint exists and is subject-bound; the verifier fails closed with
  `LEASE_REQUIRED` when a policy demands a lease.

## Execution

- **Two runners, both wired.** `deriveProjectConfig` reads `thwip.yaml` and
  picks `dagger` when the project names a `pipeline.module`, otherwise
  `command`. The pipeline is derived in process and its digest is part of the
  policy; nothing reads a committed `thwip.pipeline.json`. `main.ts` lazy-loads
  `packages/cli/src/dagger.ts` for the `dagger` runner, which provisions the
  pinned engine into its own cache and checks the download against the
  published checksum. Either way the CLI freezes the exact Git subject and
  refuses to sign if the bound tree changed during the run (FR-009).
- **Exact-source freezing uses the clean-tree invariant** (refuse dirty tree,
  re-check tree OID before and after the run) instead of materializing a
  separate read-only worktree. Untracked files are permitted but cannot be
  part of the signed subject.
- **Base binding uses `merge-base(HEAD, origin/main)`**, and the Action
  compares against `merge-base(pr_head, base_ref)` from the GitHub compare
  API. This is stable under base-branch advancement and equals the exact
  base SHA when the branch is current.

## Control plane

- **No Better Auth / dashboard yet.** The slice has no browser UI beyond a
  landing page. CLI enrollment uses a challenge + SSHSIG proof-of-possession
  gated by an operator admin token instead of the RFC 8628 device flow.
- **No GitHub App yet.** Organization/member projection is seeded via an
  admin bootstrap endpoint; verification-time permission freshness uses a
  sync token to read collaborator permissions live (>60s staleness refresh,
  fail closed). The webhook endpoint (HMAC-verified, idempotent, queued) is
  deployed and ready for an App registration.
- **Raw SQL over Drizzle** for the small D1 surface; migrations are plain
  reviewed SQL in `migrations/`.
- **Stripe webhook handled with manual HMAC verification** (no `stripe` SDK
  in the Worker); catalog created via Stripe CLI: `thwip Pro` at $5/month
  and $50/year with lookup keys `thwip_pro_monthly` / `thwip_pro_annual`.

## GitHub enforcement

- **Compatibility mode for the required check.** The plan's strongest path —
  a ruleset `workflows` rule pinned to an immutable SHA — is not available
  on this private repository's plan (GitHub rejects the rule). The active
  ruleset therefore uses `merge_queue` + `required_status_checks` pinned to
  the GitHub Actions app (`integration_id: 15368`) with context `thwip`,
  exactly the degraded mode the plan documents in §26.1. The verify workflow
  checks out `github.workflow_sha` and never executes PR-controlled code.
- **Merge queue is supported, ahead of the plan's v1 scope.** On
  `merge_group` events the Action walks the group's first-parent chain and
  independently verifies the proof on every member PR's exact head commit
  (repository, tree, ancestry, base, policy, signer, suites). The synthetic
  group commit itself is not treated as a proof subject.
- **Merge-group semantics caveat:** verifying each PR head's proof does
  not re-run CI against the combined group tree. This matches the goal
  ("the only green gate is a valid thwip proof for the PR head commit") and
  the plan's honesty requirements; the stronger group-tree rerun remains
  future work (§30, §55).

## Signing keys

- The enrolled key is a dedicated `ssh-ed25519` device key with
  proof-of-possession, one key per device, revocable via
  `POST /v1/devices/:id/revoke`. `requireGithubKeyPresence` is off because
  the operator token lacks the `write:ssh_signing_key` scope; enable it after
  adding the key to GitHub with `gh ssh-key add --type signing`.
