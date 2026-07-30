import { SITE } from "./index.js";

/**
 * Generated repository instructions and the bounded pointer (plan.md §31).
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
  readonly backend: "managed" | "native";
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
- Do not amend or force-push a queued head without rerunning \`thwip ship\`. The
  candidate someone is testing is the head you replaced.
- Ctrl-C detaches safely. It does not erase the queue request or lose your place.
- If review is required, stop and report the pull request URL and the required
  action. Do not attempt to satisfy a human requirement yourself.
- If integrated CI fails, inspect the preserved worktree, fix the feature branch,
  and rerun \`thwip ship --wait --json-events\`.
- If Thwip reports a conflict, run \`thwip queue repair --pr <number>\`.
- Treat any invariant, signature, ruleset, or permission failure as blocking and
  report it. These are not conditions to retry around.
- Work is complete only after \`queue.merge_confirmed\`, or after clearly
  reporting the durable human action required.

## Reading the queue

\`\`\`sh
thwip queue status --pr <number>      # where this pull request stands
thwip queue status --watch            # a read-only stream; claims nothing
thwip queue list                      # projected order for ${branch}
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

export function hasQueuePointer(existing: string): boolean {
  const start = existing.indexOf(POINTER_START);
  const end = existing.indexOf(POINTER_END);
  return start !== -1 && end !== -1 && end > start;
}

/** The agent prompt for adding the queue to a repository (plan.md §31.3). */
export function queueSetupPrompt(repositoryName: string): string {
  return `Add Thwip Queue to ${repositoryName}.

Work through this in order. Several steps need my approval, and two need me to
click something in GitHub that you cannot.

1. Read what is already here: AGENTS.md, CLAUDE.md, THWIP.md, thwip.yaml, any
   Dagger module, .github/workflows, CODEOWNERS, and the live repository rulesets.
   Report anything that already merges automatically — a second auto-merge system
   racing the queue is the one conflict that must be resolved before setup.

2. Run "thwip queue doctor --json" and show me the whole output.

3. Run "thwip queue setup" and show me every proposed change before applying any
   of it. Preserve all unrelated rules and instructions: a generated ruleset that
   drops an existing required check is a bug, and the diff will say so.

4. Ensure THWIP.md states the exact shipping, repair, and no-manual-merge rules,
   and add only the bounded pointer to existing agent instruction files. Do not
   rewrite instructions someone else authored.

5. Open a setup pull request. The proposed configuration must not judge itself:
   it merges under the repository's existing controls, before either queue
   ruleset is active.

6. Tell me what I have to do myself:
   - which App permissions need granting, and that it raises a consent prompt;
   - the generated "gh api" commands, which I will run;
   - that GitHub cannot source-pin a new check context in one step, so I have to
     select the Thwip App as the expected source for "Thwip / Merge" after the
     App has published it once.

7. Do not activate an enforcing policy until the canary negative test has proven
   the source pin. Activating an unverified pin is how a branch ends up requiring
   a check nothing can publish, and nothing merges after that.

Report: files changed, App permissions required, ruleset commands, doctor
results, and any conflicting auto-merge system you found.`;
}
