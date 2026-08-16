import { SITE } from "./site.js";

export const NPX_COMMAND = "npx @recallnet/thwip@latest";

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
  /** A complete invocation that works without a global installation. */
  readonly cliCommand: string;
}

const MANAGED_START = "<!-- thwip:start -->";
const MANAGED_END = "<!-- thwip:end -->";

/** The complete Thwip section stored inside the repository's root AGENTS.md. */
export function queueInstructions(facts: QueueInstructionFacts): string {
  const thwip = facts.cliCommand;

  return `## Using Thwip in this repository

Thwip checks approved local CI evidence. Live project state decides whether its
Queue controls merging of the default branch; do not
infer that state from this file. Run \`${thwip} doctor --allow-unread\` before
shipping.

## Before changing code

- Read \`thwip.yaml\` if it exists.
- Do not weaken or bypass the approved required suites.
- Changes to Thwip policy, suite definitions, this file, or the
  verifier workflow are judged by the currently active base-branch policy, never
  by the version proposed in the pull request. A pull request cannot approve its
  own policy change.

## Finish and submit

First run:

\`\`\`sh
${thwip} doctor --allow-unread
\`\`\`

### Draft or review-only work

If the user asks for a draft or review-only pull request, it still needs proof,
but it must not join the queue or merge.

- Run \`${thwip} ship --draft\`. It proves and pushes the exact HEAD, creates or
  refreshes the draft pull request, and stops without joining the queue.
- Do not mark the draft ready, join the queue, or merge unless the user asks.

### Normal completion

If doctor confirms that the project, policy, and Queue are ready, run:

\`\`\`sh
${thwip} ship --wait --json-events
\`\`\`

Thwip runs the required suites, attaches a signed work receipt, pushes or updates
the pull request, requests a fair queue turn, tests the exact integrated
candidate when the turn arrives, and asks GitHub to merge it.

If doctor does not confirm that path is ready, do not run \`ship\`. Report the
setup result and use the repository's existing reviewed pull-request flow. Do
not weaken or bypass its existing controls. Init never enrols a repository or
changes GitHub state.

## Rules when doctor confirms the Queue is ready

- Do not call \`gh pr merge\`.
- Do not merge through the GitHub UI.
- Do not push directly to the default branch.
- Do not manually rebase merely because another pull request is queued. The queue
  tests the integrated candidate for you.
- Once a turn is assigned, use only the exact candidate Thwip supplies.
- Do not amend or force-push a queued head without rerunning
  \`${thwip} ship --wait --json-events\`.
  The candidate someone is testing is the head you replaced.
- Ctrl-C detaches safely. It does not erase the queue request or lose your place.
- If review is required, stop and report the pull request URL and the required
  action. Do not attempt to satisfy a human requirement yourself.
- If integrated CI fails, inspect the preserved worktree, fix the feature branch,
  and rerun \`${thwip} ship --wait --json-events\`.
- If Thwip reports a conflict, rebase the feature branch yourself and rerun
  \`${thwip} ship --wait --json-events\`. A rebase moves the tree out from under
  the proof, so it has to be signed again; \`ship\` notices and does it.
- Treat any invariant, signature, ruleset, or permission failure as blocking and
  report it. These are not conditions to retry around.
- Work is complete only after \`queue.merge_confirmed\`, or after clearly
  reporting the durable human action required.

Docs: ${SITE}/faq
`;
}

/** A malformed managed region is never repaired by guessing at authored text. */
export class ManagedInstructionsError extends Error {
  constructor(readonly path: "AGENTS.md" | "CLAUDE.md") {
    super(`${path} has malformed or duplicate Thwip markers; fix them before init writes anything`);
    this.name = "ManagedInstructionsError";
  }
}

/** Exact marker lines outside Markdown code fences. Inline examples are authored text. */
function managedMarkers(text: string): { starts: number[]; ends: number[]; unclosedFence: boolean } {
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  let fence: { char: "`" | "~"; length: number } | null = null;
  for (const carried of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (carried.length === 0) continue;
    const line = carried.endsWith("\n") ? carried.slice(0, -1).replace(/\r$/, "") : carried;
    if (fence === null) {
      const opening = /^ {0,3}((`{3,})|(~{3,}))(.*)$/.exec(line);
      if (opening !== null && !(opening[2] !== undefined && opening[4]!.includes("`"))) {
        const delimiter = opening[1]!;
        fence = { char: delimiter[0] as "`" | "~", length: delimiter.length };
      } else if (line === MANAGED_START) {
        starts.push(offset);
      } else if (line === MANAGED_END) {
        ends.push(offset);
      }
    } else {
      const closing = new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`);
      if (closing.test(line)) fence = null;
    }
    offset += carried.length;
  }
  return { starts, ends, unclosedFence: fence !== null };
}

function managedBlock(body: string): string {
  return `${MANAGED_START}\n${body.trim()}\n${MANAGED_END}`;
}

/**
 * Replace one valid managed region or append the first one byte-for-byte after
 * authored content. Anything ambiguous refuses instead of creating a second
 * region or deleting text that Thwip does not own.
 */
function withManagedBlock(
  existing: string,
  body: string,
  path: "AGENTS.md" | "CLAUDE.md",
): string {
  const { starts, ends, unclosedFence } = managedMarkers(existing);
  const block = managedBlock(body);

  if (unclosedFence) throw new ManagedInstructionsError(path);

  if (starts.length === 0 && ends.length === 0) {
    if (existing.length === 0) return `${block}\n`;
    const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}${block}\n`;
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! <= starts[0]!) {
    throw new ManagedInstructionsError(path);
  }

  const before = existing.slice(0, starts[0]);
  const after = existing.slice(ends[0]! + MANAGED_END.length);
  return `${before}${block}${after}`;
}

/** Create or refresh the canonical Thwip contract inside AGENTS.md. */
export function withAgentInstructions(existing: string, instructions: string): string {
  return withManagedBlock(existing, instructions, "AGENTS.md");
}

/** Claude reads only this small pointer; AGENTS.md remains the only contract. */
export function claudePointer(): string {
  return "Follow the repository instructions in [AGENTS.md](AGENTS.md). AGENTS.md is the canonical agent contract.";
}

/** Create or refresh the bounded Claude compatibility pointer. */
export function withClaudePointer(existing: string): string {
  return withManagedBlock(existing, claudePointer(), "CLAUDE.md");
}

/** The agent prompt for adding the queue to a repository. */
export function queueSetupPrompt(repositoryName: string): string {
  return `Add Thwip Queue to ${repositoryName}.

Work through this in order. Enrolment is one request, and it stops in the middle
for things only I can do.

1. Read what is already here: AGENTS.md, CLAUDE.md, thwip.yaml, any
   Dagger module, .github/workflows, CODEOWNERS, and the live repository rulesets.
   Report anything that already merges automatically. A second auto-merge system
   racing the queue is the one conflict that must be resolved before setup.

2. Run "${NPX_COMMAND} init" first; it is safe when already current. Confirm
   the repository guidance it writes: the bounded Thwip section in the root
   AGENTS.md and the small CLAUDE.md pointer to it. Show me the diff. Do not
   rewrite instructions outside those bounded regions.

3. Run \`doctor --json\` with the Thwip command prefix init wrote in the managed
   AGENTS.md guidance, and show me the whole output.

4. Tell me which two checks have to be required on the protected branch at each
   stage, and why the proof publisher changes name rather than sharing one:

   - "thwip / workflow" is the Actions-owned proof gate during the staged
     handoff. Final enforcement replaces it with the App-owned "thwip" check;
     GitHub must never see the workflow and App publish the same check name.
   - "thwip / turn" says it is this pull request's turn to merge. The queue
     publishes it itself the moment it offers the lane, and it sits in progress
     rather than failing while a pull request waits. A required check that has
     failed goes on refusing the merge after the queue has authorized it.

5. Start enrolment: the "Queue" tab of this project in the dashboard, or POST
   /v1/queue/<repository id>/bootstrap. It enrols the repository and opens a
   setup pull request carrying the two workflows, then stops. Organization
   defaults are inherited; select the repository-override option only when this
   repository intentionally needs its own thwip.yaml. The proposed configuration
   must not judge itself, so that pull request merges under the controls this
   repository already has, before any Thwip check is required.

6. Tell me what I have to do myself, because you cannot:
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

7. Prove it before enforcing it. Enrolment enables the queue in observe mode while
   ownership and policy enforcement remain disabled, so the repository keeps its
   existing merge controls. Run \`ship --wait\` with the command prefix init
   wrote in AGENTS.md, on a real pull request, and confirm the proof and queue
   checks behave correctly. Then enforce the App
   proof publisher and let setup replace the proof context while the policy is
   still disabled. A required check that nothing publishes blocks every merge
   on the branch, and that is the failure this order exists to avoid.

8. Only after the App proof context is pinned and verified, confirm "Begin enforcement".
   Setup persists a recoverable canary state before the manual
   ownership handoff and records "enforced" only after it reads both active
   rulesets back. Reconcile the open pull requests before treating setup as
   complete.

Report: files changed, what enrolment answered, doctor results, the pull request
I have to merge, and any conflicting auto-merge system you found.`;
}
