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

The remote profile is SLSA Build L3: GitHub Actions performs the build and
GitHub signs the provenance with an identity the workflow cannot forge. fast
and fresh are deliberately not L3 — they are attributed assertions plus the
controls SLSA's original L4 asked for and v1.0 dropped as impractical:
hermetic execution, reproducible outputs, and optional two-party agreement.
Those are cheap here because the pipeline runs as a content-addressed graph,
so identical inputs must produce identical digests on any machine. Pick per
path: L3 where a rerun is worth the minutes, reproducibility-backed assertions
everywhere else.

## What are the security profiles: fast, fresh, audited, remote?

- **fast**: a signed local proof with no pre-run contact with the control
  plane. Works fully offline before push.
- **fresh**: the CLI first requests a short-lived lease bound to the exact
  tree, signer, and policy, so the proof also carries a trusted issuance
  window.
- **audited**: fresh, plus a random or risk-triggered independent rerun of
  the pipeline in GitHub Actions to deter false assertions.
- **remote**: the pipeline runs in GitHub for every required check
  (conventional remote CI).

Pick a profile per project in the dashboard or in `thwip.yaml`.

## What does a proof actually prove?

That an enrolled signing key asserted the approved pipeline and required
suites passed for this exact repository, Git tree, ancestry, base, and policy
version. In fast and fresh profiles the execution claim is the signer's
assertion; audited and remote add independent execution evidence.

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

In `thwip.yaml`, committed to the repository: suites, security profile, and
policy knobs. The dashboard mirrors it. A pull request can never approve its
own policy change.

## What data does the control plane hold?

Organization and permission projections from GitHub, enrolled public keys,
immutable policy versions, and verification outcomes. No source code, no
logs, no artifacts, and never a private key.
