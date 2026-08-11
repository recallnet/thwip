import { SITE } from "./index.js";

/**
 * Generated repository instructions and the bounded pointer.
 *
 * These are read by coding agents, so precision matters more than tone. The
 * prohibitions are absolute and stated as such: an agent that merges through the
 * GitHub UI while the queue is enabled bypasses the integration test the queue
 * exists to perform, and an agent that force-pushes a queued head silently
 * invalidates the candidate someone is already testing.
 */

export interface QueueInstructionFacts {
  readonly repositoryName: string;
  readonly baseRef: string;
  readonly activationState: "configured" | "observe" | "canary" | "enforced";
  readonly hasDaggerModule: boolean;
}

const POINTER_START = "<!-- thwip:start -->";
const POINTER_END = "<!-- thwip:end -->";

/** The whole of THWIP.md. */
export function queueInstructions(facts: QueueInstructionFacts): string {
  const branch = facts.baseRef.replace(/^refs\/heads\//, "");
  const observing = facts.activationState === "observe" || facts.activationState === "configured";

  return `# Shipping changes with Thwip

This repository uses Thwip for approved local CI and Queue-controlled merging of
\`${branch}\`.${
    observing
      ? `

Thwip Queue is currently in \`${facts.activationState}\`, so it reports what it
would do without blocking anything. Follow these rules anyway: they are what the
queue will enforce, and following them now is how you find out whether they work
here.`
      : ""
  }

## Before changing code

- Read \`thwip.yaml\`.
- Do not weaken or bypass the approved ${facts.hasDaggerModule ? "Dagger pipeline" : "required suites"}.
- Changes to Thwip policy, ${facts.hasDaggerModule ? "Dagger material" : "suite definitions"}, this file, or the
  verifier workflow are judged by the currently active base-branch policy, never
  by the version proposed in the pull request. A pull request cannot approve its
  own policy change.

## Finish and submit

Run:

\`\`\`sh
thwip ship --wait --json-events
\`\`\`

Thwip runs the required suites, attaches a signed work receipt, pushes or updates
the pull request, requests a fair queue turn, tests the exact integrated
candidate when the turn arrives, and asks GitHub to merge it.

## Queue rules

- Do not call \`gh pr merge\`.
- Do not merge through the GitHub UI.
- Do not push directly to \`${branch}\`.
- Do not manually rebase merely because another pull request is queued. The queue
  tests the integrated candidate for you.
- Once a turn is assigned, use only the exact candidate Thwip supplies.
- Do not amend or force-push a queued head without rerunning
  \`thwip ship --wait --json-events\`.
  The candidate someone is testing is the head you replaced.
- Ctrl-C detaches safely. It does not erase the queue request or lose your place.
- If review is required, stop and report the pull request URL and the required
  action. Do not attempt to satisfy a human requirement yourself.
- If integrated CI fails, inspect the preserved worktree, fix the feature branch,
  and rerun \`thwip ship --wait --json-events\`.
- If Thwip reports a conflict, rebase the feature branch yourself and rerun
  \`thwip ship --wait --json-events\`. A rebase moves the tree out from under
  the proof, so it has to be signed again; \`ship\` notices and does it.
- Treat any invariant, signature, ruleset, or permission failure as blocking and
  report it. These are not conditions to retry around.
- Work is complete only after \`queue.merge_confirmed\`, or after clearly
  reporting the durable human action required.

## Reading the queue

\`\`\`sh
thwip queue status --pr <number>      # where this pull request stands
thwip queue list                      # projected order for ${branch}
thwip queue explain                   # what the queue is doing and why
\`\`\`

Projected order changes after every review and check. There is no permanent
position, and Thwip will not pretend otherwise.

Docs: ${SITE}/faq
`;
}

/**
 * The bounded pointer added to existing agent instruction files. Deliberately
 * small and delimited: setup must preserve whatever the repository already says
 * to its agents, and a pointer that can be found and replaced is how a later
 * version updates itself without touching authored text.
 */
export function queuePointer(): string {
  return [
    POINTER_START,
    "Before finishing or merging a change, read `THWIP.md` and follow its CI,",
    "receipt, and Thwip Queue protocol. Do not merge with `gh pr merge` or",
    "the GitHub UI when Thwip Queue is enabled.",
    POINTER_END,
  ].join("\n");
}

/**
 * Insert or update the pointer in an existing instruction file without disturbing
 * anything else. Returns the file unchanged when the pointer is already current,
 * so setup can be re-run without producing a diff.
 */
export function withQueuePointer(existing: string): string {
  const pointer = queuePointer();
  const start = existing.indexOf(POINTER_START);
  const end = existing.indexOf(POINTER_END);

  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + POINTER_END.length);
    const replaced = `${before}${pointer}${after}`;
    return replaced === existing ? existing : replaced;
  }

  // A malformed remnant — one delimiter without the other — is left alone rather
  // than guessed at, and the pointer is appended.
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${pointer}\n`;
}

/** The agent prompt for adding the queue to a repository. */
export function queueSetupPrompt(repositoryName: string): string {
  return `Add Thwip Queue to ${repositoryName}.

Work through this in order. Enrolment is one request, and it stops in the middle
for things only I can do.

1. Read what is already here: AGENTS.md, CLAUDE.md, THWIP.md, thwip.yaml, any
   Dagger module, .github/workflows, CODEOWNERS, and the live repository rulesets.
   Report anything that already merges automatically. A second auto-merge system
   racing the queue is the one conflict that must be resolved before setup.

2. Run "thwip queue doctor --json" and show me the whole output.

3. Offer to install Thwip's managed, non-blocking pre-push warning. Explain that
   it applies to the main worktree and every linked worktree, never replaces an
   unmanaged hook, and can be bypassed for a deliberate low-level Git push.
   Only after I explicitly approve, run "thwip setup --install-push-warning".
   If I decline, continue without it.

4. Tell me which two checks have to be required on the protected branch at each
   stage, and why the proof publisher changes name rather than sharing one:

   - "thwip / workflow" is the Actions-owned proof gate during the staged
     handoff. Final enforcement replaces it with the App-owned "thwip" check;
     GitHub must never see the workflow and App publish the same check name.
   - "thwip / turn" says it is this pull request's turn to merge. The queue
     publishes it itself the moment it offers the lane, and it sits in progress
     rather than failing while a pull request waits. A required check that has
     failed goes on refusing the merge after the queue has authorized it.

5. Write the repository's own instructions: run "thwip queue setup --write". It
   writes THWIP.md and adds only the bounded pointer to the AGENTS.md and
   CLAUDE.md that already exist. Show me the diff. Do not rewrite instructions
   someone else authored.

6. Start enrolment: the "Set up" tab of this project in the dashboard, or POST
   /v1/queue/<repository id>/bootstrap. It enrols the repository and opens a
   setup pull request carrying the two workflows, then stops. Organization
   defaults are inherited; select the repository-override option only when this
   repository intentionally needs its own thwip.yaml. The proposed configuration
   must not judge itself, so that pull request merges under the controls this
   repository already has, before any Thwip check is required.

7. Tell me what I have to do myself, because you cannot:
   - merge the setup pull request, which is where enrolment is waiting;
   - first apply only the disabled policy payloads enrolment returns, in the order
     shown, using my own repository-administrator authority;
   - after the observe proof below, enforce the App proof publisher and apply
     the disabled-policy replacement of "thwip / workflow" with "thwip";
   - only after that replacement is verified, explicitly begin enforcement,
     then apply the ownership and active-policy payloads;
   - confirm every bypass-actor list in GitHub exactly matches the expected lists
     shown at confirmation (only the Thwip App bypasses
     ownership).
   Start enrolment again after each manual change. It reads the branch rulesets
   back, checks that each is pinned to the source that publishes it, initially
   requires "thwip / workflow" and "thwip / turn", and refuses a payload that
   would drop a rule or required check somebody else added. It adds no review policy; GitHub layers
   the repository's existing review controls alongside the queue rules. GitHub
   hides bypass actors from an App that cannot edit rulesets, so I must verify
   that one field explicitly. The App does not request the broad
   "administration: write" permission. The installed App performs authorized
   merges with repository-scoped Contents write and the narrower Workflows write
   needed when a reviewed commit changes CI definitions; setup needs no personal
   access token or repository merge secret.

8. Prove it before enforcing it. Enrolment enables the queue in observe mode while
   ownership and policy enforcement remain disabled, so the repository keeps its
   existing merge controls. Run "thwip ship --wait" on a real pull request and
   confirm the proof and queue checks behave correctly. Then enforce the App
   proof publisher and let setup replace the proof context while the policy is
   still disabled. A required check that nothing publishes blocks every merge
   on the branch, and that is the failure this order exists to avoid.

9. Only after the App proof context is pinned and verified, confirm "Begin enforcement".
   Setup persists a recoverable canary state before the manual
   ownership handoff and records "enforced" only after it reads both active
   rulesets back. Reconcile the open pull requests before treating setup as
   complete.

Report: files changed, what enrolment answered, doctor results, the pull request
I have to merge, and any conflicting auto-merge system you found.`;
}
