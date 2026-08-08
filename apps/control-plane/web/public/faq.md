# thwip FAQ

## What is thwip?

A control plane that turns the CI runs your agent already did into a signed proof a GitHub check can verify in seconds. The pipeline runs on the machine where the code lives, the CLI signs a compact claim about the exact Git tree, and the thwip GitHub App verifies that claim on the pull request. thwip never sees your source code and runs nothing; it checks evidence about what ran.

## Can someone fake a proof?

They can sign a claim without running the checks, the same way anyone can write "tests pass" in a pull request. What changes is the cost. They have to use a key enrolled to their GitHub account, spend the time the run would have taken, and state a fingerprint for every step. Those fingerprints are identical on every machine that runs the same code, so the claim has to keep agreeing with everyone else's runs forever. The first time it doesn't, the signed claim is the evidence.

## Does thwip watch my tests?

No. thwip never sees your code and runs nothing. It checks that a signed claim matches the exact commit, the approved checks, and a signer who currently has access.

## Some changes are too important to take someone's word for.

Set those paths to run in GitHub. GitHub signs the result, so the developer isn't the source of the claim. Most teams do this for auth, billing, deploy config, and lockfiles.

## How does this map to SLSA?

The remote profile is SLSA Build L3. GitHub Actions performs the build and GitHub signs the provenance with an identity the workflow cannot forge. Fast is deliberately not L3. It is an attributed assertion plus the controls SLSA's original L4 asked for and v1.0 dropped as impractical: hermetic execution, reproducible outputs, and optional two-party agreement. Those are cheap here because the pipeline runs as a content-addressed graph, so identical inputs must produce identical digests on any machine. Pick per path: L3 where a rerun is worth the minutes, a reproducibility-backed assertion everywhere else.

## Which security profiles can I pick?

Four. **fast**: the required suites run on the machine where the code lives and the CLI signs the proof locally. Nothing is leased or approved in advance, and the queue can merge on the proof already attached to the branch. The CLI does read the policy it runs under — the repository's own `thwip.yaml`, or the organization defaults from the dashboard — so a run that never contacts the control plane needs a complete local `thwip.yaml` and a repository the CLI has already resolved once. **remote**: the pipeline runs in GitHub for every required check (conventional remote CI). **fresh**: the required suites run on your own machine. The queue signs an assignment naming the candidate tree and the suites to run, your machine runs them and signs a receipt naming what ran and against what tree, and the control plane checks the receipt against the assignment before it merges. **audited**: fresh plus a second, independent run of the same suites in GitHub Actions. The merge waits on both the local receipt and that remote verdict. Pick organization defaults in the dashboard; use `thwip.yaml` only where a repository needs to override them.

## What does a proof actually prove?

That an enrolled signing key asserted the approved pipeline and required suites passed for this exact repository, Git tree, ancestry, base, and policy version. Under fast, the execution claim is the signer's own assertion. Under remote, GitHub ran the required suites and signed for them.

## How does a teammate join?

They sign in with GitHub at https://thwip.recall.net. Membership, roles, and repository permissions come from the GitHub organization, so there are no invitations. Outside collaborators invited to individual repositories on GitHub count too: their per-repository permission is their standing. Removing someone on GitHub removes their standing here too.

## How do I express a build matrix, services, or several platforms?

In your Dagger module, not in `thwip.yaml`. A matrix is a loop, a database is a service binding, a platform is an argument — all in a real language, with types and tests. `thwip.yaml` only names which module functions are required and where each may run, so thwip owns no pipeline dialect of its own. macOS and Windows cannot run in a Linux container, so a cross-platform matrix is genuinely hybrid: list those suites under `remote:` and GitHub runs and signs them, while everything else is proven locally. One merge gate, two sources of evidence — and the remote half is SLSA Build L3. The CLI provisions the pinned Dagger version into its own cache and verifies the download against the published checksum. Using thwip does not mean installing another global toolchain; it does need a container runtime.

## Where do signing keys come from?

GitHub. thwip does not issue, store, or enroll keys — it reads the signing keys you have registered on your GitHub account, and a proof names a key by its OpenSSH fingerprint, which anyone can compute from the public key. Run `thwip keys status` to see which key on your machine would sign and whether GitHub lists it. Removing a key from GitHub stops it verifying. You can also deny one of your own keys from the dashboard: it stops verifying in this organization immediately, without touching your GitHub account.

## Do commits have to be signed?

The proof is its own signature and does not depend on git commit signatures. If you want signed commits too, `thwip init` can configure git to sign with the same enrolled SSH key, and your ruleset can additionally require signed commits.

## What happens on a rebase or squash?

The proof binds the exact tree and ancestry, so a rebase, squash, or cherry-pick needs a new `thwip run`. Thwip Queue itself always writes a merge commit on the exact base and tree it verified; setup exposes no merge-method choice.

## Where do project settings live?

Organization proof defaults live in the dashboard. A repository may commit a partial `thwip.yaml` whose fields override those defaults after the file reaches the protected default branch. Candidate pull-request configuration is never used to approve itself.

## Who publishes the required proof check?

The thwip GitHub App evaluates the exact pull-request head and publishes the `thwip` check directly. New projects start with a distinct `thwip / proof (observe)` check, and an administrator enforces it once that check has passed. The repository workflow and the App use different names. During the staged handoff, GitHub Actions publishes `thwip / workflow`, satisfied by the `thwip-required.yml` the setup pull request adds. Once an administrator enforces the App's proof check, setup replaces that requirement with the App-owned `thwip` context. GitHub therefore never has to evaluate two same-named checks while the App writes the protected branch. Every evaluation produces a service-signed audit record containing the exact subject, base, policy, verifier version, signer outcomes, and GitHub check-run id. A rerun creates another record instead of overwriting history.

## Why are there two required checks?

They answer different questions and change at different times. The active proof gate says the proof is good for this exact tree. It is `thwip / workflow` during the staged Actions handoff and the App-owned `thwip` after enforcement. That fact stays true until the commit changes. `thwip / turn` says it is this pull request's turn to merge. Only one pull request holds the lane at a time, so this one moves whenever the queue offers the turn to somebody else. While a pull request is waiting, its turn check sits in progress rather than failing. Waiting is not a failure, and a required check that has failed keeps refusing the merge until something re-runs it — which is how a queue ends up offering a turn to a pull request that cannot take it. Nothing has to be re-run for the turn check to go green. The queue publishes it the moment it offers the lane.

## What data does the control plane hold?

Organization and permission projections from GitHub, enrolled public keys, immutable policy versions, and verification outcomes. No source code, no logs, no artifacts, and never a private key.
