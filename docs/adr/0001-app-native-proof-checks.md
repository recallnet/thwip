# ADR 0001: App-native proof checks and queue writes

## Status

Accepted for issue #53 and extended for the Queue setup path.

## Decision

The Thwip GitHub App owns proof verification, queue checks, and the final branch
write. There is one supported queue writer and one supported merge shape: the
installed App composes a merge commit on the base the queue verified and moves
the target ref without force.

The App publishes the required `thwip` check for pull requests. The verifier
evaluates the exact pull-request head, uses the shared verifier package, and
executes no repository code. Configuration resolves in this order:

1. built-in schema and safety constraints;
2. organization proof defaults managed in the dashboard;
3. an optional `thwip.yaml` from the active default-branch policy.

Repository fields override organization defaults. Arrays replace arrays and
mapping sections merge by field. Configuration from the candidate pull request
is never used to approve that pull request.

Each evaluation creates an immutable database row and a service-signed audit
record containing the subject, base, policy digest and version, verifier version,
individual outcomes, check-run id, and timestamp.

The App requires `checks:write`, `contents:write`, `pull_requests:write`, and
`statuses:write` for queue operation. Contents write creates the commit object,
moves the branch, opens the setup pull request, and dispatches the protected
candidate verifier. Ruleset reads use `metadata:read`.

The runtime does not require `administration:write`. GitHub gates ruleset writes
behind that coarse permission, so setup instead renders exact ruleset payloads,
waits for a repository administrator to apply them, and reads the resulting
configuration back before advancing. GitHub also hides bypass actors from a
read-only App; the administrator explicitly confirms that the live bypass list
matches the generated payload before activation.

## Why the App writes the merge

Keeping the writer in the control plane removes an adopter-owned branch
credential and keeps the base-binding guard in code this repository tests. The
App writes the exact verified tree with the pinned base as its first parent and
updates the ref with `force: false`. GitHub refuses that update if the base has
moved. The Worker retries only GitHub's narrow, transient refusal while its own
newly-concluded required check is still being observed.

The trust cost is explicit: a compromised control plane with the installation
token can write repository contents for every repository in that installation,
and revocation means suspending or uninstalling the App. The ownership ruleset
limits protected-branch updates to the App, while deletion and non-fast-forward
updates remain blocked.

There is no writer, backend, or merge-method selector in setup or runtime state.
The schema cleanup drops those obsolete columns after the Worker deployment that
stops reading them. Older signed records may still parse their historical merge
method so audit history remains verifiable; new Queue merges always use merge
commits.

## Why not Administration: write by default?

We could request `administration:write`. That would make setup one-click, let the
App create and update every staged ruleset, verify bypass actors without human
attestation, and simplify permission upgrades across large fleets.

We do not request it by default because it grants permanent installation
authority over sensitive repository settings well beyond the queue's runtime
job. The least-privilege path trades a few explicit administrator-applied
ruleset changes during setup for a materially smaller ongoing trust boundary.
Teams that prefer automated fleet provisioning can revisit that tradeoff or use
a separate, short-lived setup integration.

## Setup sequence

Fresh repositories follow one path:

1. Install or approve the Thwip App with the required runtime permissions.
2. Start setup. Thwip opens a pull request containing the proof and candidate
   verifier workflows; `thwip.yaml` appears only for an explicit repository
   override.
3. Merge that pull request under the repository's existing controls.
4. Apply the generated disabled policy ruleset and source-pinning update. Thwip
   reads both back before continuing.
5. Run in `observe` with policy and ownership disabled, and validate the proof
   and queue checks on a real pull request.
6. Enforce the App proof publisher, then replace `thwip / workflow` with
   App-owned `thwip` in the still-disabled policy and verify the stored pin.
7. Explicitly begin queue enforcement. Apply the App ownership and active-policy
   payloads, confirm their bypass actors, and let Thwip verify the live rulesets.

The order prevents a no-publisher gap. In observe mode the repository workflow
publishes `thwip / workflow`, while the App publishes
`thwip / proof (observe)`. The App begins publishing `thwip`, then the disabled
ruleset replaces the Actions-owned workflow context with the App-owned context,
and only after that does queue enforcement activate.
The names are distinct because GitHub can refuse a protected-ref update while
an unrelated same-named check is still running, even when the required context
is pinned to the App.

Setup is intentionally not a migration engine. A repository with conflicting
branch automation or old protection must be cleaned up by an administrator
before this sequence can complete. Thwip detects and explains the conflict; it
does not maintain an alternate runtime path to bridge it.

## Failure and rollback

Every state-changing webhook and queue route wakes the App writer. A scheduled
Worker reconciliation also drives quiet lanes, so repository Actions are not a
runtime wake-up mechanism.

If the App is removed, its permission upgrade is incomplete, a bundle cannot be
resolved, or audit signing fails, the required check remains missing, failing,
or in progress rather than producing success. Rollback pauses the queue and has
an administrator disable or remove the generated rulesets; it does not switch to
a second writer. Audit records and policy versions remain append-only.

## Consequences

App ownership removes a repository merge workflow and secret from the trust
boundary, gives teams a consistent onboarding path, and makes an installation
upgrade apply across repositories. It does not eliminate protected GitHub
Actions used to verify proof or run the integrated candidate; those workflows
execute verification, not branch writes.

Fork pull requests are read through the base repository's Pull Requests and
compare APIs. The service reads commit metadata and the proof carrier only; it
does not fetch a fork worktree, execute candidate code, or expose an App token to
candidate-controlled code.
