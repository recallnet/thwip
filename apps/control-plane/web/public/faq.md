# thwip FAQ

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
invitations. Removing someone on GitHub removes their standing here too.

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
