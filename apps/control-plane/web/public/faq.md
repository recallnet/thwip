# thwip FAQ

## Can someone fake a proof?

Yes. A `fast` proof is a signed claim. It does not independently prove that the
commands ran. Thwip verifies the signer, signing key, Git tree, base, pipeline,
suite results, proof age, and current policy.

Use `remote` for an independent GitHub run. Use `audited` to require both a
device run and a GitHub run. Set `policy.allow_author_as_signer: false` if an
author must not sign their own proof.

## Does thwip watch my tests?

No. The CLI runs the approved suite commands on your machine and records whether
they passed. The control plane does not run repository code or read test logs. It
checks the signed proof against the commit and the active policy.

## What if some checks must run in GitHub?

List their suite IDs under `remote:` in `thwip.yaml`. Each ID must match its
GitHub check-run name. The proof passes only after those checks pass on the same
pull-request head.

The `remote` profile also runs the integrated candidate in GitHub Actions. The
`audited` profile requires both that GitHub run and a signed device run.

## How does this relate to SLSA?

Thwip does not currently claim a SLSA level. The `remote` and `audited` profiles
use GitHub Actions and record its verdict, but the standard candidate workflow
does not create or distribute SLSA provenance. A hosted runner alone does not
meet SLSA Build L3.

## Which security profiles can I pick?

Four, from least to most independent evidence.

- **fast**: reuse the signed proof on the pull-request head. Do not run the
  integrated candidate again.
- **fresh**: assign the integrated candidate to a connected device. The device
  runs the required suites and returns a signed receipt.
- **remote**: run the required suites on the integrated candidate in the pinned
  GitHub Actions workflow.
- **audited**: require both the signed device receipt and the GitHub Actions
  verdict for the integrated candidate.

Choose organization defaults in the dashboard. Add a partial `thwip.yaml` only
when one repository needs different settings.

## What does a proof actually prove?

A proof shows that an allowed GitHub signing key signed a statement about one
Git tree, its parents, its base, its pipeline, and its suite results. The
verifier also checks the active policy, the signer's current repository access,
the key's current status, and the proof's age.

Under `fast`, the suite results remain the signer's claim.

## How does a teammate join?

They sign in with GitHub at https://thwip.ai. Thwip copies organization roles and
repository permissions from GitHub. There is no separate Thwip invitation.

Outside collaborators keep only the access GitHub gives them for each
repository. Removing a member, collaborator, or permission in GitHub removes
that access after the next sync or verification.

## How do I express a build matrix, services, or several platforms?

Put execution logic in package scripts or a Dagger module. `thwip.yaml` names
suite IDs; it is not a pipeline language. A Dagger module can define loops and
services. The CLI downloads the pinned Dagger version, checks its checksum, and
uses your container runtime.

Put platform-specific remote jobs in their own GitHub workflows and list their
check names under `remote:`. The standard integrated-candidate workflow runs
`pnpm` scripts on Ubuntu. It does not create a macOS or Windows matrix.

## Where do signing keys come from?

Use an SSH key that GitHub lists as a **Signing Key**. The CLI uses the private
key locally. The control plane reads the public key from GitHub and stores its
public value and fingerprint for verification and audit. It never receives the
private key.

Run `thwip keys status` to see which local key would sign. Removing the key from
GitHub stops new verifications. An organization administrator can also deny its
fingerprint in Thwip.

## Do commits have to be signed?

No. A proof has its own signature. Run `thwip init --sign-commits` if you also
want Git to sign commits with the same SSH key. A GitHub ruleset can require
signed commits separately.

## What happens on a rebase or squash?

Run `thwip run` again after a rebase, squash, or cherry-pick. A proof binds the
exact tree, parents, and base.

Thwip Queue creates a merge commit with the verified base as its first parent
and the verified pull-request tree as its result. Setup does not offer another
merge method.

## Where do project settings live?

Organization defaults live in the dashboard. A repository can commit a partial
`thwip.yaml` to override them. Arrays replace default arrays. Fields inside
mapping sections merge with their defaults.

Only the file on the protected default branch applies. A pull request cannot
approve itself by changing its own policy.

## Who publishes the required proof check?

After enforcement, the Thwip GitHub App publishes the required `thwip` check.
Before enforcement, GitHub Actions publishes `thwip / workflow` and the App
publishes `thwip / proof (observe)`. An administrator switches to the App check
only after the observe check passes.

Each completed App evaluation gets its own database record and a service-signed
audit record. A rerun creates a new evaluation instead of replacing the old one.

## Why are there two required checks?

They answer different questions.

- `thwip` says the proof is valid for the current tree.
- `thwip / turn` says this pull request currently holds the queue lane.

The turn check stays in progress while the pull request waits. It passes when
the queue offers that pull request the lane. During setup, `thwip / workflow`
temporarily fills the proof-check role.

## What data does the control plane hold?

The control plane stores account and session data, encrypted GitHub OAuth
tokens, Stripe customer and subscription IDs, GitHub organization and
repository permission copies, public signing keys and fingerprints, policies,
verification outcomes, and signed queue records.

It does not store repository source code, test logs, build artifacts, or users'
private SSH keys.
