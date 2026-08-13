/**
 * The files a repository needs before the queue can run on it.
 *
 * Enrolling `recallnet/thwip-test` took copying these workflows in by hand,
 * which is why nothing about them was reviewable and why the next repository
 * would have taken the same afternoon. They are offered as a pull request
 * instead: the repository's own reviewers approve them under the controls it
 * already has, before either Thwip ruleset is active, which is the whole point
 * of `merge-setup-pr` being the first bootstrap step.
 *
 * The workflows are this repository's own, with two changes. The action is a
 * published reference rather than the local checkout only this repository has,
 * and the endpoint is the control plane the caller is deployed at.
 * `bootstrap-workflows.test.ts` compares the names and triggers against the
 * originals, because those are what the ruleset pins.
 *
 * The candidate verifier was missing from this list entirely. `remote` and
 * `audited` claim the integrated candidate was run, and the control plane asks
 * for that run with `repository_dispatch: thwip-queue-verify`. Every repository
 * enrolled through the product got a dispatch nothing listened to, because this
 * repository's own copy of the answering workflow was written by hand and the
 * template never learned about it.
 *
 * The merge is deliberately absent. The installed App composes and lands the
 * merge itself; setup never adds a repository merge workflow or asks an adopter
 * for a branch-write token.
 */

export interface SetupFile {
  readonly path: string;
  readonly content: string;
}

/** Where the setup pull request comes from. Namespaced so it cannot collide. */
export const SETUP_BRANCH = "thwip/setup";

export const SETUP_PULL_REQUEST_TITLE = "Set up Thwip Queue" as const;

/**
 * The published action the rendered workflows call.
 *
 * One constant because there are two renderers. The bootstrap route writes these
 * workflows into a customer repository and `scripts/generate-workflows.mjs`
 * writes this repository's own copy; a literal in each is how the two drift, and
 * drift here means an adopted repository running a different action from the one
 * this repository tests.
 */
export const QUEUE_ACTION_REF = "recallnet/thwip@2c47d61a145c2a7cc245326ccae090c279378962";

/**
 * An explicit repository override for teams that choose one during setup.
 *
 * It is deliberately absent by default. Organization defaults are the policy
 * source for most repositories; silently committing this complete Node-shaped
 * file would override those defaults everywhere and defeat that model.
 */
const THWIP_YAML = `# thwip.yaml - thwip settings for this repository
# docs: https://thwip.ai/faq
# Repository identity comes from the git remote; suite commands come from
# package.json scripts (or an explicit \`suites:\` map for non-node repos).
version: 4
profile: fast
required:
  - lint
  - typecheck
  - test
`;

const REQUIRED_WORKFLOW = `name: thwip

# Whether the proof is good for this exact tree, and nothing else.
#
# Whose turn it is used to be answered here too, which meant one check carrying
# two answers that change on different clocks. It went red for every pull request
# that was merely waiting, and a failed required check goes on refusing the merge
# after the queue has authorized it. The queue publishes \`thwip / turn\` itself
# now, the moment it offers the lane.

run-name: >-
  thwip: verify proof for PR #\${{ github.event.pull_request.number }} :
  \${{ github.event.pull_request.title }}

on:
  pull_request:

permissions:
  contents: read
  # The proof verifier authenticates to the control plane with an OIDC token, so
  # this is the action's own requirement rather than the queue step's.
  id-token: write
  checks: write
  # Reading the pull request and the candidate commit GitHub simulated for it.
  pull-requests: read

jobs:
  thwip:
    name: thwip / workflow
    runs-on: ubuntu-latest
    steps:
      - name: Verify thwip proof for the exact PR head commit
        uses: __ACTION_REF__
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          THWIP_ENDPOINT: __ENDPOINT__
      # Place this pull request in the queue, and tell it what the proof said.
      #
      # This is what enrols the entry, derives its readiness from the proof, and
      # moves the lane on. It does not decide this check: whose turn it is is
      # published by the queue as \`thwip / turn\`.
      #
      # This step is what makes the queue decide rather than merely observe. It
      # runs from the workflow's own pinned revision, so nothing here executes
      # code from the pull request, and the OIDC token binds the repository. In
      # observe the endpoint always authorizes and reports what it would have
      # said, so adoption stays reversible.
      - name: Thwip Queue authorization
        id: queue
        if: github.event_name == 'pull_request'
        # Nothing this step does decides this check. If the queue is unreachable,
        # the pull request is not enrolled and \`thwip / turn\` never goes green, so
        # the merge is blocked by the check that is actually about the turn. The
        # block is visible, and nothing claims the proof was bad.
        continue-on-error: true
        env:
          THWIP_ENDPOINT: __ENDPOINT__
          REPO_ID: \${{ github.event.repository.id }}
          PR: \${{ github.event.pull_request.number }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          BASE_REF: refs/heads/\${{ github.event.pull_request.base.ref }}
          AUTHOR_ID: \${{ github.event.pull_request.user.id }}
          DRAFT: \${{ github.event.pull_request.draft }}
        run: |
          set -uo pipefail
          # Fetch the OIDC token, reporting what came back rather than letting jq
          # fail on an unexpected body. The token itself is never printed.
          raw=$(curl -sS -w '\\n%{http_code}' \\
            -H "authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
            "\${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=\${THWIP_ENDPOINT}/api/github-actions" || true)
          code=$(printf '%s' "$raw" | tail -n1)
          payload=$(printf '%s' "$raw" | sed '$d')
          echo "oidc token request: http $code, \${#payload} bytes"
          if [ "$code" != "200" ]; then
            echo "::error::could not obtain an OIDC token (http $code)"
            exit 1
          fi
          oidc=$(printf '%s' "$payload" | jq -r '.value // empty')
          if [ -z "$oidc" ]; then
            echo "::error::OIDC response carried no token"
            exit 1
          fi

          # The base, the candidate and its tree are read by the queue, from
          # GitHub, at the moment it pins them. This step sends none of them.
          body=$(jq -nc \\
            --argjson pr "$PR" --arg head "$HEAD_SHA" --arg base "$BASE_REF" \\
            --arg author "$AUTHOR_ID" --argjson draft "\${DRAFT:-false}" \\
            '{pullRequestNumber:$pr, headSha:$head, baseRef:$base, authorGithubUserId:$author, draft:$draft}')

          # A refusal and an outage are different answers. The queue saying "not
          # your turn" is about this pull request. The queue being unreachable is
          # about us, says nothing about this pull request, and used to fail the
          # check permanently: a quota exhaustion once stopped every merge in the
          # repository and nothing recovered without a human re-running jobs.
          attempt=0
          while :; do
            out=$(curl -sS -w '\\n%{http_code}' -X POST \\
              -H "authorization: Bearer $oidc" -H "content-type: application/json" \\
              -d "$body" "$THWIP_ENDPOINT/v1/queue/$REPO_ID/authorize" || true)
            acode=$(printf '%s' "$out" | tail -n1)
            abody=$(printf '%s' "$out" | sed '$d')
            echo "authorize: http $acode"
            echo "$abody"
            case "$acode" in
              200) break ;;
              429|500|502|503|504)
                attempt=$((attempt + 1))
                if [ "$attempt" -ge 6 ]; then
                  echo "::error::Thwip Queue is unreachable (http $acode after $attempt tries). This says nothing about this pull request; re-run this check once the queue is back."
                  exit 1
                fi
                echo "queue unreachable (http $acode); retrying in $((attempt * 15))s"
                sleep $((attempt * 15))
                ;;
              *)
                echo "::error::Thwip Queue authorization endpoint returned http $acode"
                exit 1
                ;;
            esac
          done
          # Reported, never fatal.
          #
          # Whose turn it is belongs to \`thwip / turn\`, which the queue publishes
          # itself. Failing this check for "not your turn" is what made a required
          # check go red for merely waiting, and a failed required check goes on
          # refusing the merge after the queue has authorized it.
          #
          # The call stays because it is what places the pull request in the
          # queue, derives its readiness from the proof, and moves the lane on.
          # Only the exit code moved.
          echo "Thwip Queue says: $(printf '%s' "$abody" | jq -r '.reason // "UNKNOWN"')"
`;

const VERIFY_WORKFLOW = `name: thwip-queue-verify

# Thwip verifier callback protocol: 3

run-name: >-
  thwip: verify candidate \${{ github.event.client_payload.candidateSha }}
  for PR #\${{ github.event.client_payload.pullRequestNumber }}

# Dispatched by the control plane when a pull request holds the turn and its
# integrated candidate has not been tested yet.
#
# repository_dispatch always runs the default branch's copy of this file. That is
# the point: a pull request can edit a workflow that runs on pull_request, and a
# verifier a contributor can edit verifies nothing. Everything below — the suite
# commands, the toolchain, the reporting — comes from main. Only the code under
# test comes from the candidate.
on:
  repository_dispatch:
    types: [thwip-queue-verify]

jobs:
  # Validate the control-plane-owned suite list before GitHub expands it into a
  # matrix. This job checks out nothing and receives no token permission.
  prepare:
    name: prepare trusted suite matrix
    runs-on: ubuntu-latest
    permissions: {}
    outputs:
      suites: \${{ steps.suites.outputs.suites }}
    steps:
      - name: Validate the required suite list
        id: suites
        env:
          REQUIRED_SUITES: \${{ toJSON(github.event.client_payload.requiredSuites) }}
        run: |
          node <<'NODE'
          const suites = JSON.parse(process.env.REQUIRED_SUITES ?? "null");
          if (!Array.isArray(suites) || suites.length === 0 || suites.length > 32) {
            throw new Error("the dispatch must name between 1 and 32 required suites");
          }
          const valid = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
          if (suites.some((suite) => typeof suite !== "string" || !valid.test(suite))) {
            throw new Error("the dispatch contains an invalid required suite id");
          }
          if (new Set(suites).size !== suites.length) {
            throw new Error("the dispatch contains a duplicate required suite id");
          }
          require("node:fs").appendFileSync(process.env.GITHUB_OUTPUT, "suites=" + JSON.stringify(suites) + "\\n");
          NODE

  verify:
    name: verify candidate / \${{ matrix.suite }}
    needs: prepare
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      # Candidate-controlled install, build and suite code runs in this job.
      # It must never receive OIDC or a repository write capability. Each suite
      # runs on its own hosted runner, and no output, cache or artifact crosses
      # the trust boundary into the reporter.
      contents: read
    strategy:
      fail-fast: false
      matrix:
        suite: \${{ fromJSON(needs.prepare.outputs.suites) }}
    steps:
      # The candidate commit itself: the merge GitHub simulated for this pull
      # request. This is the integration that will land, which is the thing no
      # earlier check has ever run.
      - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
        with:
          ref: \${{ github.event.client_payload.candidateSha }}
          persist-credentials: false

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 24

      - uses: pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda # v4.1.0

      # Confirm the checkout is the tree the control plane pinned before running
      # anything. If it is not, the run would report on code the queue did not ask
      # about, and reporting it would be worse than not running.
      - name: Confirm the candidate tree
        env:
          EXPECTED_TREE: \${{ github.event.client_payload.candidateTreeOid }}
        run: |
          set -euo pipefail
          actual=$(git rev-parse HEAD^{tree})
          echo "candidate tree: $actual (expected $EXPECTED_TREE)"
          if [ "$actual" != "$EXPECTED_TREE" ]; then
            echo "::error::checked out tree does not match the pinned candidate"
            exit 1
          fi

      - name: Install
        run: pnpm install --frozen-lockfile

      # Workspace packages resolve to their built types, so typecheck cannot run
      # from a clean checkout until they exist. A developer's tree already has
      # them, which is why only a clean-room run of the candidate ever noticed.
      - name: Build workspace packages
        run: pnpm build

      # The suite id came through the validated matrix and enters the shell only
      # as a quoted environment value. The command remains the repository's
      # reviewed package-script mapping; the reporter never consumes its output.
      - name: Run required suite
        env:
          NODE_OPTIONS: --max-old-space-size=4096
          SUITE: \${{ matrix.suite }}
        run: |
          set -euo pipefail
          case "$SUITE" in
            ""|[!a-z0-9]*|*[!a-z0-9_.-]*)
              echo "::error::the matrix supplied an invalid suite id"
              exit 1
              ;;
          esac
          if [ "\${#SUITE}" -gt 64 ]; then
            echo "::error::the matrix supplied an invalid suite id"
            exit 1
          fi
          pnpm run "$SUITE"

  report:
    name: register trusted candidate report
    needs: [prepare, verify]
    if: \${{ always() && needs.prepare.result == 'success' }}
    runs-on: ubuntu-latest
    permissions:
      # This clean job is the only place that can mint the report identity. It
      # has no repository or Actions read capability and consumes no candidate
      # output, artifact, cache, environment or workspace.
      id-token: write
    steps:
      # Register only a dispatch nonce. The App waits for this job to finish,
      # reads GitHub's exact run-attempt jobs, and derives the verdict itself.
      - name: Register the candidate report with Thwip Queue
        env:
          THWIP_ENDPOINT: __ENDPOINT__
          REPO_ID: \${{ github.event.repository.id }}
          DISPATCH_NONCE: \${{ github.event.client_payload.dispatchNonce }}
          EXPECTED_WORKFLOW_SHA: \${{ github.event.client_payload.workflowCommitSha }}
          ACTUAL_WORKFLOW_SHA: \${{ github.workflow_sha }}
        run: |
          set -euo pipefail
          if [ "$ACTUAL_WORKFLOW_SHA" != "$EXPECTED_WORKFLOW_SHA" ]; then
            echo "::error::the verifier did not start from the dispatched workflow commit"
            exit 1
          fi
          raw=$(curl -sS -w '\\n%{http_code}' \
            -H "authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "\${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=\${THWIP_ENDPOINT}/api/github-actions" || true)
          code=$(printf '%s' "$raw" | tail -n1)
          payload=$(printf '%s' "$raw" | sed '$d')
          if [ "$code" != "200" ]; then
            echo "::error::could not obtain an OIDC token (http $code)"
            exit 1
          fi
          oidc=$(printf '%s' "$payload" | jq -r '.value // empty')
          if [ -z "$oidc" ]; then
            echo "::error::OIDC response carried no token"
            exit 1
          fi
          body=$(jq -nc --arg nonce "$DISPATCH_NONCE" '{dispatchNonce:$nonce}')
          out=$(curl -sS -w '\\n%{http_code}' -X POST \
            -H "authorization: Bearer $oidc" -H "content-type: application/json" \
            -d "$body" "$THWIP_ENDPOINT/v1/queue/$REPO_ID/candidate-result" || true)
          rcode=$(printf '%s' "$out" | tail -n1)
          echo "candidate-report: http $rcode"
          printf '%s\\n' "$out" | sed '$d'
          if [ "$rcode" != "202" ]; then
            echo "::error::Thwip Queue did not register the candidate report (http $rcode)"
            exit 1
          fi
`;

export interface SetupPullRequestInput {
  /** The control plane the workflows talk to. */
  readonly endpoint: string;
  /** The published action, `owner/repo@ref`. Never a local path. */
  readonly actionRef: string;
  /** Add a complete repository override only when the administrator chose one. */
  readonly includeRepositoryConfig?: boolean;
}

function render(template: string, input: SetupPullRequestInput): string {
  return template.replaceAll("__ENDPOINT__", input.endpoint).replaceAll("__ACTION_REF__", input.actionRef);
}

export function setupPullRequestFiles(input: SetupPullRequestInput): readonly SetupFile[] {
  return [
    { path: ".github/workflows/thwip-required.yml", content: render(REQUIRED_WORKFLOW, input) },
    verifierWorkflowFile(input),
    ...(input.includeRepositoryConfig === true ? [{ path: "thwip.yaml", content: THWIP_YAML }] : []),
  ];
}

export function verifierWorkflowFile(input: SetupPullRequestInput): SetupFile {
  return { path: ".github/workflows/thwip-queue-verify.yml", content: render(VERIFY_WORKFLOW, input) };
}

export function verifierUpgradePullRequestBody(input: SetupPullRequestInput): string {
  return [
    "This reviewed change upgrades only Thwip's candidate verifier callback protocol.",
    "",
    "Protocol 2 binds every result to the exact Thwip project incarnation and queue attempt that dispatched it.",
    "Each required suite now runs without report authority; a separate trusted job reports only GitHub-owned job conclusions.",
    "",
    `The workflow reports to ${input.endpoint}.`,
  ].join("\n");
}

/** What the pull request says it is for, so a reviewer is not guessing. */
export function setupPullRequestBody(input: SetupPullRequestInput): string {
  return [
    "Thwip Queue merges one pull request at a time onto this branch, with a signed record of each merge.",
    "",
    "This pull request adds what the queue needs and nothing else:",
    "",
    "- `.github/workflows/thwip-required.yml` publishes `thwip / workflow`, which verifies the proof during the staged handoff and places the pull request in the queue. Enforcement later replaces that requirement with the App-owned `thwip` check; the two publishers never share a name.",
    "- The installed Thwip App performs the merge with repository-scoped `contents: write`, plus `workflows: write` when a reviewed merge changes CI definitions. A repository administrator applies the generated rulesets; the App does not request `administration: write`. No repository merge token is needed.",
    "- `.github/workflows/thwip-queue-verify.yml` runs the required suites against the integrated candidate when the queue asks for it. The `remote` and `audited` profiles need it; `fast` and `fresh` never dispatch to it.",
    ...(input.includeRepositoryConfig === true
      ? ["- `thwip.yaml` is the repository-specific policy override selected for this setup. Edit it before merging if these are not the right suites."]
      : ["- No `thwip.yaml` is added. This repository inherits organization defaults; use `thwip init` separately only if it needs an explicit repository override."]),
    "",
    "The queue writes merge commits. It composes the merge on the base it verified and lands it with a ref update that does not force, so a base that moved refuses the merge rather than producing a tree nothing ran. Setup has no merge-method selector.",
    "",
    `The workflows talk to ${input.endpoint}.`,
    "",
    "Merge this under the controls this repository already has. Thwip changes no branch ruleset itself. After this merges, Continue setup returns the exact ruleset payloads for a repository administrator to apply, then verifies them before enabling the queue.",
  ].join("\n");
}
