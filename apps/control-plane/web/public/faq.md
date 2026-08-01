# thwip FAQ

## Can someone fake a proof?

They can sign a claim without running the checks, the same way anyone can
write "tests pass" in a pull request. What changes is the cost. They have to
use a key enrolled to their GitHub account, spend the time the run would have
taken, and state a fingerprint for every step. Those fingerprints are
identical on every machine that runs the same code, so the claim has to keep
agreeing with everyone else's runs forever. The first time it doesn't, the
signed claim is the evidence.

## Does thwip watch my tests?

No. thwip never sees your code and runs nothing. It checks that a signed claim
matches the exact commit, the approved checks, and a signer who currently has
access.

## Some changes are too important to take someone's word for.

Set those paths to run in GitHub. GitHub signs the result, so the developer
isn't the source of the claim. Most teams do this for auth, billing, deploy
config, and lockfiles.

## How does this map to SLSA?

The remote profile is SLSA Build L3. GitHub Actions performs the build and
GitHub signs the provenance with an identity the workflow cannot forge. Fast
is deliberately not L3. It is an attributed assertion plus the controls
SLSA's original L4 asked for and v1.0 dropped as impractical: hermetic
execution, reproducible outputs, and optional two-party agreement. Those are
cheap here because the pipeline runs as a content-addressed graph, so
identical inputs must produce identical digests on any machine. Pick per
path: L3 where a rerun is worth the minutes, a reproducibility-backed
assertion everywhere else.

## Which security profiles can I pick?

Two.

- **fast**: a signed local proof with no pre-run contact with the control
  plane. Works fully offline before push.
- **remote**: the pipeline runs in GitHub for every required check
  (conventional remote CI).

Pick organization defaults in the dashboard; use `thwip.yaml` only where a
repository needs to override them.

## The schema mentions fresh and audited. Can I use them?

No, and the CLI refuses them by name rather than quietly delivering something
else. Both are defined as issuing an assignment and requiring an integration
receipt signed where the suites ran. Nothing issues one and nothing signs one
yet, so a repository that asked for either would get what remote gives under a
name claiming more than happened.

## What does a proof actually prove?

That an enrolled signing key asserted the approved pipeline and required
suites passed for this exact repository, Git tree, ancestry, base, and policy
version. Under fast, the execution claim is the signer's own assertion. Under
remote, GitHub ran the required suites and signed for them.

## How does a teammate join?

They sign in with GitHub at https://thwip.recall.net. Membership, roles, and
repository permissions come from the GitHub organization, so there are no
invitations. Outside collaborators invited to individual repositories on GitHub count too: their per-repository permission is their standing. Removing someone on GitHub removes their standing here too.

## How do I express a build matrix, services, or several platforms?

In your Dagger module, not in thwip.yaml. A matrix is a loop, a database is a
service binding, a platform is an argument — all in a real language, with
types and tests. thwip.yaml only names which module functions are required and
where each may run, so thwip owns no pipeline dialect of its own.

macOS and Windows cannot run in a Linux container, so a cross-platform matrix
is genuinely hybrid: list those suites under `remote:` and GitHub runs and
signs them, while everything else is proven locally. One merge gate, two
sources of evidence — and the remote half is SLSA Build L3.

The CLI provisions the pinned Dagger version into its own cache and verifies
the download against the published checksum. Using thwip does not mean
installing another global toolchain; it does need a container runtime.

## Where do signing keys come from?

GitHub. thwip does not issue, store, or enroll keys — it reads the signing
keys you have registered on your GitHub account, and a proof names a key by
its OpenSSH fingerprint, which anyone can compute from the public key. Run
`thwip keys status` to see which key on your machine would sign and whether
GitHub lists it. Removing a key from GitHub stops it verifying; an
organization can also deny a key from the dashboard for faster revocation.

## Do commits have to be signed?

The proof is its own signature and does not depend on git commit signatures.
If you want signed commits too, `thwip init` can configure git to sign with
the same enrolled SSH key, and your ruleset can additionally require signed
commits.

## What happens on a rebase or squash?

The proof binds the exact tree and ancestry, so a rebase, squash, or
cherry-pick needs a new `thwip run`. The merge queue uses the MERGE method so
the trailer survives into the merge group, where every member PR's head proof
is verified again.

## Where do project settings live?

Organization proof defaults live in the dashboard. A repository may commit a
partial `thwip.yaml` whose fields override those defaults after the file
reaches the protected default branch. Candidate pull-request configuration is
never used to approve itself.

## Who publishes the required proof check?

The thwip GitHub App evaluates the exact pull-request head or merge-group
members and publishes the `thwip` check directly. New and migrated projects
start with a distinct `thwip / proof (observe)` check. After that check passes,
an administrator can enforce the App check and pin the required context to the
thwip App without an unprotected cutover.

Every evaluation produces a service-signed audit record containing the exact
subject, base, policy, verifier version, signer outcomes, and GitHub check-run
id. A rerun creates another record instead of overwriting history.

## Why are there two required checks?

They answer different questions and change at different times.

`thwip` says the proof is good for this exact tree. That is a fact about the
commit, and it stays true until the commit changes.

`thwip / turn` says it is this pull request's turn to merge. Only one pull
request holds the lane at a time, so this one moves whenever the queue offers
the turn to somebody else.

While a pull request is waiting, its turn check sits in progress rather than
failing. Waiting is not a failure, and a required check that has failed keeps
refusing the merge until something re-runs it — which is how a queue ends up
offering a turn to a pull request that cannot take it.

Nothing has to be re-run for the turn check to go green. The queue publishes it
the moment it offers the lane.

## What data does the control plane hold?

Organization and permission projections from GitHub, enrolled public keys,
immutable policy versions, and verification outcomes. No source code, no
logs, no artifacts, and never a private key.
