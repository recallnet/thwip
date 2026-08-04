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
 * The two workflows are this repository's own, with two changes. The action is
 * a published reference rather than the local checkout only this repository
 * has, and the endpoint is the control plane the caller is deployed at.
 * `bootstrap-workflows.test.ts` compares the names and triggers against the
 * originals, because those are what the ruleset pins.
 *
 * The merge workflow is not a copy at all any more. There were two of them and
 * they drifted twice: the attribution trailer went missing from one, and PR 123
 * taught this repository's copy to bind the base it verified while every adopted
 * repository went on merging onto whatever the branch was at that instant. So
 * `MERGE_WORKFLOW` below is the merge, and `.github/workflows/thwip-merge.yml`
 * is what it renders at the production endpoint. `scripts/generate-workflows.mjs`
 * writes that file and `scripts/lint.mjs` fails when it is not what this emits.
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
export const QUEUE_ACTION_REF = "recallnet/thwip@v1";

/**
 * A default `thwip.yaml`. Committed rather than assumed, because policy is
 * derived from what the repository says about itself and a repository with no
 * file has said nothing.
 */
const THWIP_YAML = `# thwip.yaml - thwip settings for this repository
# docs: https://thwip.recall.net/faq
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
  thwip: verify proof \${{ github.event_name == 'merge_group'
    && format('for merge group {0}', github.event.merge_group.head_sha)
    || format('for PR #{0} : {1}', github.event.pull_request.number, github.event.pull_request.title) }}

on:
  pull_request:
  merge_group:

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
    name: thwip
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
        # the merge is blocked by the check that is actually about the turn :
        # visibly, and without claiming the proof was bad.
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
            '{pullRequestNumber:$pr, headSha:$head, baseRef:$base, authorGithubUserId:$author, draft:$draft, proofAccepted:true}')

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

const MERGE_WORKFLOW = `name: thwip-merge

# The merge Thwip Queue authorized.
#
# This cannot live inside the \`thwip\` job: that job *is* the required check, so the
# branch cannot be mergeable while it is still running. GitHub answers 405 and the
# queue would appear to be refusing when it had in fact authorized. So the merge
# waits for that workflow to conclude and then runs here.
#
# workflow_run executes in the base branch's context with the base branch's code,
# never the pull request's, which is what makes it safe to hold a token that can
# write.

on:
  workflow_run:
    workflows: [thwip]
    types: [completed]
  # The queue asking for a turn to be driven.
  #
  # workflow_run alone made merging depend on a check happening to be in flight
  # at the instant the queue offered a turn. Every other offer expired ninety
  # seconds later unclaimed, so the queue cycled offers nobody could take and
  # nothing merged. A queue has to drive the work, not wait to be noticed.
  repository_dispatch:
    types: [thwip-queue-turn]

# One merge run at a time, because there is one lane at a time.
#
# This was keyed per pull request, and a pull request is not what is being
# serialised. The lane belongs to a base branch: one pull request holds it, is
# integrated against the base, verified, and merged, and nothing else merges
# meanwhile. Two pull requests meant two groups meant two runs driving one lane.
# On 2 August 2026 pull requests 117 and 119 both pinned base 1511515c1241 and
# landed on two different bases, and 114 did the same. The attestation refused to
# sign any of the three, which is how we found out.
#
# So the group names the queue. It cannot name the base ref as well: this workflow
# is reached by two triggers, repository_dispatch carries only a pull request
# number and workflow_run carries a base ref only for same-repository pull
# requests, so any attempt to read the base here puts two triggers for one lane
# into two different groups. That is the same bug spelled differently. A group
# keyed on the repository holds every lane in it, which serialises base branches
# against each other; a repository with two queues merges a little slower and
# never merges twice at once.
#
# It also still does the job it was added for: the drain re-runs every blocked
# check at once, each of those fires a merge run, and only one of them runs.
concurrency:
  group: thwip-merge-\${{ github.repository }}
  # Never cancel. A run past the ref update has moved the branch and has not yet
  # told the queue, and a cancel there is a merge with no transition record, the
  # one outcome this queue exists to prevent. Runs do not pile up in exchange:
  # each one asks the queue once and exits, GitHub holds a single pending run per
  # group and drops the rest, and a turn nobody claimed is offered again.
  cancel-in-progress: false

permissions:
  contents: read
  pull-requests: read
  # To read the candidate verdict the verifier published on this head, rather
  # than asking the control plane for it.
  checks: read
  id-token: write

jobs:
  merge:
    name: merge
    if: >-
      github.event_name == 'repository_dispatch' ||
      (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request')
    runs-on: ubuntu-latest
    steps:
      - name: Merge under Thwip Queue authorization
        env:
          THWIP_ENDPOINT: __ENDPOINT__
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          MERGE_TOKEN: \${{ secrets.THWIP_ENQUEUE_TOKEN }}
          REPO_ID: \${{ github.event.repository.id }}
          HEAD_SHA: \${{ github.event.workflow_run.head_sha }}
          DISPATCHED_PR: \${{ github.event.client_payload.pullRequestNumber }}
        run: |
          set -uo pipefail
          if [ -z "\${MERGE_TOKEN:-}" ]; then
            echo "::notice::no merge token available; leaving the merge to a maintainer"
            exit 0
          fi

          # Resolve the pull request. From the head commit the check ran on, so
          # this can never merge a different pull request than the one verified;
          # or from the number the queue named when it asked for this turn.
          if [ -n "\${DISPATCHED_PR:-}" ]; then
            pr=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$DISPATCHED_PR" \\
                   --jq 'select(.state=="open")' || true)
            HEAD_SHA=$(printf '%s' "$pr" | jq -r '.head.sha // empty')
          else
            pr=$(gh api "repos/$GITHUB_REPOSITORY/commits/$HEAD_SHA/pulls" \\
                   --jq '[.[] | select(.state=="open")][0] // empty')
          fi
          if [ -z "$pr" ]; then
            echo "::notice::no open pull request for $HEAD_SHA"
            exit 0
          fi
          PR=$(printf '%s' "$pr" | jq -r .number)
          BASE_REF="refs/heads/$(printf '%s' "$pr" | jq -r .base.ref)"
          AUTHOR_ID=$(printf '%s' "$pr" | jq -r .user.id)
          DRAFT=$(printf '%s' "$pr" | jq -r .draft)
          echo "pull request #$PR onto $BASE_REF"

          oidc() {
            curl -sS -H "authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
              "\${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=\${THWIP_ENDPOINT}/api/github-actions" | jq -r .value
          }

          # Ask the queue again. Idempotent, and it is the queue — not this
          # workflow — that decides whether this pull request holds the turn.
          #
          # This run used to read the base, the test merge and its tree and send
          # all three. The queue signed against whatever that reading had become
          # by the time it arrived, and on 2 August 2026 four merges landed on a
          # base signed sixteen seconds earlier than the branch had moved. The
          # queue reads those objects for itself now, at the moment it pins
          # them, so nothing about the commit is sent from here.
          body=$(jq -nc --argjson pr "$PR" --arg head "$HEAD_SHA" --arg base "$BASE_REF" \\
            --arg author "$AUTHOR_ID" --argjson draft "$DRAFT" \\
            '{pullRequestNumber:$pr, headSha:$head, baseRef:$base, authorGithubUserId:$author, draft:$draft, proofAccepted:true, prepare:true}')

          # Ask once. That call starts the candidate verification if nothing has
          # run this tree yet.
          out=$(curl -sS -w '\\n%{http_code}' -X POST -H "authorization: Bearer $(oidc)" \\
            -H "content-type: application/json" -d "$body" \\
            "$THWIP_ENDPOINT/v1/queue/$REPO_ID/authorize" || true)
          code=$(printf '%s' "$out" | tail -n1); abody=$(printf '%s' "$out" | sed '$d')
          echo "authorize: http $code"; echo "$abody"
          [ "$code" = "200" ] || { echo "::error::authorize returned $code"; exit 1; }

          # No waiting. If the candidate has not been verified yet, that ask has
          # just started the verification, and the queue calls this workflow back
          # once the verdict lands. Every run does one thing and exits.
          #
          # Waiting here was the orchestrator's job done in the wrong place: six
          # pull requests each sat in a loop asking who was next, when the one
          # thing that knows is the queue.
          if [ "$(printf '%s' "$abody" | jq -r '.candidate // empty')" = "verification-requested" ]; then
            echo "candidate verification started; the queue will call back when it lands"
            exit 0
          fi

          authorized=$(printf '%s' "$abody" | jq -r '.authorized // false')
          enforcing=$(printf '%s' "$abody" | jq -r '.enforcing // false')
          op=$(printf '%s' "$abody" | jq -r '.operationId // empty')
          # The method the record the queue just signed already bound. Read
          # from the same answer rather than typed again here, so this and the
          # record it will later be checked against cannot silently disagree.
          method=$(printf '%s' "$abody" | jq -r '.mergeMethod // "merge"')
          if [ "$enforcing" != "true" ]; then
            echo "queue is observing; not merging"; exit 0
          fi
          if [ "$authorized" != "true" ] || [ -z "$op" ]; then
            echo "queue did not authorize a merge: $(printf '%s' "$abody" | jq -r .reason)"; exit 0
          fi

          # The base, the tree and the parents the queue signed for this merge.
          #
          # This run used to read the base for itself and then hand GitHub an
          # expected head and nothing else, because the merge-pull-request API
          # has no expected base. Pull requests 114, 117 and 119 were each
          # signed against one base, merged onto another, and produced a tree no
          # suite had ever run — and GitHub called all three a success. The base
          # the intent bound is a fact the queue holds, so the queue is what
          # says it.
          base_pin=$(printf '%s' "$abody" | jq -r '.merge.baseSha // empty')
          tree_pin=$(printf '%s' "$abody" | jq -r '.merge.treeOid // empty')
          parents=$(printf '%s' "$abody" | jq -c '.merge.parentShas // []')
          if [ -z "$base_pin" ] || [ -z "$tree_pin" ] || [ "$parents" = "[]" ]; then
            echo "::error::the queue named no base for this merge; nothing will be merged"
            exit 1
          fi
          if [ "$method" != "merge" ]; then
            # A squash commit does not contain the pull request head, so the
            # branch's own required checks refuse the ref update below, and
            # GitHub offers no other way to say "merge only onto this base".
            # Refusing costs a squash repository its merges. Merging anyway
            # costs everyone the one claim this queue exists to make.
            #
            # The queue authorized a merge that is now not going to happen, so
            # it hears that here. Otherwise the lane stays held until its
            # deadline and every pull request behind this one waits on a merge
            # nobody is going to make.
            curl -sS -o /dev/null -X POST -H "authorization: Bearer $(oidc)" \\
              -H "content-type: application/json" \\
              -d "$(jq -nc --arg base "$BASE_REF" --arg attempt "\${op#merge_}" --arg op "$op" \\
                    --arg detail "SQUASH_UNBINDABLE $method" \\
                    '{baseRef:$base, attemptId:$attempt, operationId:$op, detail:$detail}')" \\
              "$THWIP_ENDPOINT/v1/queue/$REPO_ID/not-merged" || true
            echo "::error::this repository merges by $method, and a $method commit does not contain the pull request head, so there is no way to bind it to the base the queue verified; nothing was merged. Set the queue to merge commits, or leave this pull request to a maintainer."
            exit 1
          fi

          title="Merge pull request #$PR (Thwip Queue)"
          # printf, so the trailer's blank line never appears literally in YAML.
          trailer=$(printf 'Integrated by Thwip Queue.\\n\\nthwip-queue-operation: %s\\n' "$op")
          # GitHub's merge API joined a title and a body; a git commit has one
          # message, so this run does the joining.
          msg=$(printf '%s\\n\\n%s' "$title" "$trailer")

          # Write the merge commit ourselves: the pinned base as the first
          # parent, the pull request head as the second, and the tree the
          # verifier ran. Nothing is computed here, so nothing can drift from
          # what the record binds.
          written=$(curl -sS -w '\\n%{http_code}' -X POST \\
            -H "authorization: Bearer $MERGE_TOKEN" -H "accept: application/vnd.github+json" \\
            -H "content-type: application/json" \\
            -d "$(jq -nc --arg msg "$msg" --arg tree "$tree_pin" --argjson parents "$parents" \\
                  '{message:$msg, tree:$tree, parents:$parents}')" \\
            "https://api.github.com/repos/$GITHUB_REPOSITORY/git/commits" || true)
          wcode=$(printf '%s' "$written" | tail -n1); wbody=$(printf '%s' "$written" | sed '$d')
          if [ "$wcode" != "201" ] && [ "$wcode" != "200" ]; then
            echo "::error::could not write the merge commit ($wcode: $(printf '%s' "$wbody" | jq -r '.message // "no message"')); nothing was merged"
            exit 1
          fi
          composed=$(printf '%s' "$wbody" | jq -r '.sha // empty')
          if [ -z "$composed" ]; then
            echo "::error::GitHub wrote the merge commit and named no sha; nothing was merged"; exit 1
          fi
          echo "composed $composed on base $base_pin with tree $tree_pin"

          # Move the branch to it, without force.
          #
          # This is the whole guard. GitHub accepts a ref update without force
          # only where the branch is an ancestor of the new commit, and the only
          # branch that is an ancestor of this commit is the base it was
          # composed on. If the base moved, GitHub answers 422 "Update is not a
          # fast forward" and the merge does not happen at all.
          resp=$(curl -sS -w '\\n%{http_code}' -X PATCH \\
            -H "authorization: Bearer $MERGE_TOKEN" -H "accept: application/vnd.github+json" \\
            -H "content-type: application/json" \\
            -d "$(jq -nc --arg sha "$composed" '{sha:$sha, force:false}')" \\
            "https://api.github.com/repos/$GITHUB_REPOSITORY/git/refs/heads/\${BASE_REF#refs/heads/}" || true)
          mcode=$(printf '%s' "$resp" | tail -n1); payload=$(printf '%s' "$resp" | sed '$d')
          echo "land: http $mcode"
          landed=""
          if [ "$mcode" = "200" ] || [ "$mcode" = "201" ]; then
            landed=$(printf '%s' "$payload" | jq -r '.object.sha // empty')
          fi

          if [ -z "$landed" ]; then
            reason=$(printf '%s' "$payload" | jq -r '.message // "no message"')

            # A base that moved is not a refusal to retry. The candidate was
            # verified against a base that no longer exists, so the queue takes
            # the turn back, pins the new base, and runs the suites again. What
            # must never happen is this run reaching for the new base itself.
            case "$reason" in
              *"not a fast forward"*)
                curl -sS -o /dev/null -X POST -H "authorization: Bearer $(oidc)" \\
                  -H "content-type: application/json" \\
                  -d "$(jq -nc --arg base "$BASE_REF" --arg attempt "\${op#merge_}" --arg op "$op" \\
                        --arg detail "BASE_MOVED off $base_pin" \\
                        '{baseRef:$base, attemptId:$attempt, operationId:$op, detail:$detail}')" \\
                  "$THWIP_ENDPOINT/v1/queue/$REPO_ID/not-merged" || true
                echo "::error::BASE_MOVED: the base branch is no longer $base_pin, which is what this candidate was verified against; nothing was merged"
                exit 1
                ;;
            esac

            # The status code says what this call did, not what happened to the
            # pull request.
            #
            # Two merge runs can race for one turn. One merges; the other is told
            # 405 "Merge already in progress" and used to report that as a
            # refusal, which declares a merge did not happen at the moment it
            # just did. The queue then terminated the attempt, refused the real
            # confirmation, and the branch moved with no transition record: a
            # merge nobody could audit, which is the one outcome this exists to
            # prevent.
            #
            # So ask GitHub what became of the pull request instead of reading it
            # off the response to our own call. Both racing runs then report the
            # same merge under the same idempotency key, which is harmless.
            #
            # And ask more than once. GitHub's reads are eventually consistent
            # with GitHub's own writes: pull request 105 merged at 16:41:38 and
            # answered \`merged: false\` at 16:41:39, so the single re-read below
            # reported a refusal for a merge that was already on main. Every read
            # has to agree, over a backoff, and git has to agree too — if the
            # base branch contains the head commit then the merge landed whatever
            # the pull request says about itself.
            #
            # And take the sha off the branch when git is what settled it. A
            # pull request that has not caught up with its own merge still
            # answers \`merge_commit_sha\` with the test merge GitHub computes for
            # an open pull request: the real merge's parents, the real merge's
            # tree, a different commit, and on no branch. Pull request 107's
            # losing run reported that sha and chain record 54 says main became
            # a commit main never was. The merge is the commit on the base
            # branch whose parents include the head, and that is what gets
            # reported.
            merge_on_base() {
              gh api "repos/$GITHUB_REPOSITORY/commits?sha=\${BASE_REF#refs/heads/}&per_page=100" \\
                --jq "[.[] | select(any(.parents[]; .sha == \\"$HEAD_SHA\\"))][0].sha // empty" 2>/dev/null || echo ""
            }

            confirm_landed() {
              unreadable=0
              for wait in 0 2 4; do
                [ "$wait" = "0" ] || sleep "$wait"
                state=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR" \\
                  --jq '{merged:(.merged // false), sha:(.merge_commit_sha // "")}' 2>/dev/null || echo '{}')
                if [ "$(printf '%s' "$state" | jq -r '.merged // false')" = "true" ]; then
                  printf '%s' "$(printf '%s' "$state" | jq -r '.sha // empty')"
                  return 0
                fi
                cmp=$(gh api "repos/$GITHUB_REPOSITORY/compare/\${BASE_REF#refs/heads/}...$HEAD_SHA" \\
                  --jq '.status // empty' 2>/dev/null || echo "")
                if [ "$cmp" = "behind" ] || [ "$cmp" = "identical" ]; then
                  onbase=$(merge_on_base)
                  if [ -n "$onbase" ]; then
                    printf '%s' "$onbase"
                    return 0
                  fi
                  # Git says it landed and the branch will not name the commit,
                  # which is the one case where guessing writes a false record.
                  unreadable=1
                  continue
                fi
                if [ -z "$cmp" ] || [ "$state" = "{}" ]; then unreadable=1; fi
              done
              [ "$unreadable" = "1" ] && return 2
              return 1
            }

            landed=$(confirm_landed)
            confirmation=$?

            if [ "$confirmation" = "0" ]; then
              echo "::notice::this run did not perform the merge ($mcode: $reason), but the pull request is merged; recording it"
            elif [ "$confirmation" = "1" ]; then
              case "$mcode" in
                405|409|422)
                  # A refusal, and every read agrees the pull request is unmerged.
                  # Tell the queue so the lane frees now rather than waiting for a
                  # deadline and then needing an operator. The queue confirms this
                  # for itself before it records anything.
                  curl -sS -o /dev/null -X POST -H "authorization: Bearer $(oidc)" \\
                    -H "content-type: application/json" \\
                    -d "$(jq -nc --arg base "$BASE_REF" --arg attempt "\${op#merge_}" --arg op "$op" --arg detail "$mcode $reason" \\
                          '{baseRef:$base, attemptId:$attempt, operationId:$op, detail:$detail}')" \\
                    "$THWIP_ENDPOINT/v1/queue/$REPO_ID/not-merged" || true
                  echo "::error::GitHub refused the merge ($mcode: $reason); the queue has released the lane"
                  ;;
                *)
                  # Anything unclear is left to reconciliation, never retried here.
                  echo "::error::merge outcome unclear ($mcode: $reason); leaving it to reconciliation"
                  ;;
              esac
              exit 1
            else
              # Could not read GitHub well enough to say either way. Unknown is
              # never reported as a refusal.
              echo "::error::could not confirm what became of #$PR ($mcode: $reason); leaving it to reconciliation"
              exit 1
            fi
          fi

          if [ -z "$landed" ]; then
            echo "::error::merged, but GitHub named no commit; leaving it to reconciliation"; exit 1
          fi
          commit=$(gh api "repos/$GITHUB_REPOSITORY/git/commits/$landed" --jq '{tree:.tree.sha, parents:[.parents[].sha]}')
          report=$(curl -sS -w '\\n%{http_code}' -X POST -H "authorization: Bearer $(oidc)" \\
            -H "content-type: application/json" \\
            -d "$(jq -nc --arg base "$BASE_REF" --arg attempt "\${op#merge_}" --arg op "$op" \\
                  --arg sha "$landed" --arg tree "$(printf '%s' "$commit" | jq -r .tree)" \\
                  --argjson parents "$(printf '%s' "$commit" | jq -c .parents)" \\
                  '{baseRef:$base, attemptId:$attempt, operationId:$op, mergeSha:$sha, mergeTree:$tree, parentShas:$parents}')" \\
            "$THWIP_ENDPOINT/v1/queue/$REPO_ID/merged" || true)
          echo "queue record: http $(printf '%s' "$report" | tail -n1)"
          printf '%s' "$report" | sed '$d'
`;

export interface SetupPullRequestInput {
  /** The control plane the workflows talk to. */
  readonly endpoint: string;
  /** The published action, `owner/repo@ref`. Never a local path. */
  readonly actionRef: string;
}

function render(template: string, input: SetupPullRequestInput): string {
  return template.replaceAll("__ENDPOINT__", input.endpoint).replaceAll("__ACTION_REF__", input.actionRef);
}

export function setupPullRequestFiles(input: SetupPullRequestInput): readonly SetupFile[] {
  return [
    { path: ".github/workflows/thwip-required.yml", content: render(REQUIRED_WORKFLOW, input) },
    { path: ".github/workflows/thwip-merge.yml", content: render(MERGE_WORKFLOW, input) },
    { path: "thwip.yaml", content: THWIP_YAML },
  ];
}

/** What the pull request says it is for, so a reviewer is not guessing. */
export function setupPullRequestBody(input: SetupPullRequestInput): string {
  return [
    "Thwip Queue merges one pull request at a time onto this branch, with a signed record of each merge.",
    "",
    "This pull request adds what the queue needs and nothing else:",
    "",
    "- `.github/workflows/thwip-required.yml` publishes the `thwip` check, which says whether the proof is good for the tree, and places the pull request in the queue.",
    "- `.github/workflows/thwip-merge.yml` performs the merge the queue authorizes. It needs a `THWIP_ENQUEUE_TOKEN` repository secret; without one it declines and leaves the merge to a maintainer.",
    "- `thwip.yaml` says which suites have to pass. Edit it before merging if these are not the right ones.",
    "",
    "The merge is a merge commit, composed on the base the queue verified against and landed with a ref update that does not force, so a base that moved refuses the merge rather than producing a tree nothing ran. A squash cannot be bound that way: it does not contain the pull request head, so this branch's own required checks refuse it and GitHub cannot tell the pull request was merged. If this repository squashes, the workflow says so, merges nothing, and hands the lane back. Set the queue to merge commits before enabling it.",
    "",
    `Both workflows talk to ${input.endpoint}.`,
    "",
    "Merge this under the controls this repository already has. Thwip creates no branch ruleset until it has merged, so nothing here can block the branch.",
  ].join("\n");
}
