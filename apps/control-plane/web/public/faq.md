# thwip FAQ

## Can someone fake a proof?

They can sign a claim without running the checks. Anyone can write "tests pass" in a pull request the same way. What changes is the cost. They must use a key enrolled to their GitHub account. They must spend the time the run would have taken. They must state a fingerprint for every step. Those fingerprints are identical on every machine that runs the same code. The claim must keep agreeing with everyone else's runs. The first time it disagrees, the signed claim is the evidence.

## Does thwip watch my tests?

No. thwip never sees your code and runs nothing. It checks that a signed claim matches the exact commit, the approved checks, and a signer who currently has access.

## Some changes are too important to take someone's word for.

Set those paths to run in GitHub. GitHub signs the result. The developer is not the source of the claim. Most teams do this for auth, billing, deploy config, and lockfiles.

## How does this map to SLSA?

The remote profile is SLSA Build L3. GitHub Actions performs the build. GitHub signs the provenance with an identity the workflow cannot forge.

Fast is deliberately not L3. It is an attributed assertion plus three controls: hermetic execution, reproducible outputs, and optional two-party agreement. SLSA's original L4 asked for those controls. SLSA v1.0 dropped them as impractical. They are cheap here because the pipeline runs as a content-addressed graph. Identical inputs must produce identical digests on any machine.

Choose per path. Use L3 where a rerun is worth the minutes. Use a reproducibility-backed assertion everywhere else.

## Which security profiles can I pick?

Four.

- **fast**: a signed local proof with no pre-run contact with the control plane. Works fully offline before push.
- **fresh**: the required suites run on your own machine. The queue signs an assignment. The assignment names the candidate tree and the suites to run. Your machine runs them and signs a receipt. The receipt names what ran and against what tree. The control plane checks the receipt against the assignment before it merges.
- **remote**: the pipeline runs in GitHub for every required check. This is conventional remote CI.
- **audited**: fresh plus a second run of the same suites in GitHub Actions. The second run is independent. The merge waits on both the local receipt and the remote verdict.

Pick organization defaults in the dashboard. Use `thwip.yaml` only where a repository needs to override them.

## What does a proof actually prove?

A proof says that an enrolled signing key asserted the approved pipeline and required suites passed for this exact repository, Git tree, ancestry, base, and policy version. Under fast, the execution claim is the signer's own assertion. Under remote, GitHub ran the required suites and signed for them.

## How does a teammate join?

They sign in with GitHub at https://thwip.ai. Membership, roles, and repository permissions come from the GitHub organization. There are no invitations. Outside collaborators invited to individual repositories also count: their per-repository permission is their standing. Removing someone on GitHub removes their standing here too.

## How do I express a build matrix, services, or several platforms?

In your Dagger module, not in thwip.yaml. A matrix is a loop. A database is a service binding. A platform is an argument. All three live in a real language, with types and tests. thwip.yaml only names which module functions are required and where each may run. Thwip owns no pipeline dialect of its own.

macOS and Windows cannot run in a Linux container. A cross-platform matrix is therefore hybrid. List those suites under `remote:` and GitHub runs and signs them. Everything else is proven locally. One merge gate, two sources of evidence. The remote half is SLSA Build L3.

The CLI provisions the pinned Dagger version into its own cache. It verifies the download against the published checksum. Using thwip does not mean installing another global toolchain. It does need a container runtime.

## Where do signing keys come from?

GitHub. thwip does not issue, store, or enroll keys. It reads the signing keys you registered on your GitHub account. A proof names a key by its OpenSSH fingerprint. Anyone can compute that fingerprint from the public key. Run `thwip keys status` to see which key on your machine would sign, and whether GitHub lists it. Removing a key from GitHub stops it verifying. An organization can also deny a key from the dashboard for faster revocation.

## Do commits have to be signed?

The proof is its own signature. It does not depend on git commit signatures. If you want signed commits too, `thwip init` can configure git to sign with the same enrolled SSH key. Your ruleset can also require signed commits.

## What happens on a rebase or squash?

The proof binds the exact tree and ancestry. A rebase, squash, or cherry-pick therefore needs a new `thwip run`. Thwip Queue always writes a merge commit on the exact base and tree it verified. Setup exposes no merge-method choice.

## Where do project settings live?

Organization proof defaults live in the dashboard. A repository may commit a partial `thwip.yaml`. Its fields override the defaults after the file reaches the protected default branch. Candidate pull-request configuration never approves itself.

## Who publishes the required proof check?

The thwip GitHub App evaluates the exact pull-request head and publishes the `thwip` check directly. New projects start with a distinct `thwip / proof (observe)` check. An administrator enforces it once that check has passed.

The repository workflow and the App use different names. During the staged handoff, GitHub Actions publishes `thwip / workflow`. The setup pull request adds `thwip-required.yml`, the workflow that publishes it. Once an administrator enforces the App's proof check, setup replaces that requirement with the App-owned `thwip` context. GitHub therefore never has to evaluate two same-named checks while the App writes the protected branch.

Every evaluation produces a service-signed audit record. The record contains the exact subject, base, policy, verifier version, signer outcomes, and GitHub check-run id. A rerun creates another record. It does not overwrite history.

## Why are there two required checks?

They answer different questions and change at different times.

The active proof gate says the proof is good for this exact tree. It is `thwip / workflow` during the staged Actions handoff. It is the App-owned `thwip` after enforcement. That fact stays true until the commit changes.

`thwip / turn` says it is this pull request's turn to merge. Only one pull request holds the lane at a time. This one moves whenever the queue offers the turn to somebody else.

While a pull request waits, its turn check sits in progress. It does not fail. Waiting is not a failure. A required check that failed keeps refusing the merge until something re-runs it. That is how a queue ends up offering a turn to a pull request that cannot take it.

The queue publishes the turn check the moment it offers the lane. Nothing has to re-run for the check to go green.

## What data does the control plane hold?

The control plane holds organization and permission projections from GitHub, enrolled public keys, immutable policy versions, and verification outcomes. It holds no source code, no logs, no artifacts, and never a private key.
