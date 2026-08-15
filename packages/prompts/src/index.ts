/**
 * One init prompt shared by the dashboard, the CLI, and published Markdown.
 * The CLI fills in facts it has read. The website leaves them unknown and asks
 * the latest CLI to inspect the current checkout.
 */

import { SITE } from "./site.js";

export { SITE } from "./site.js";

import { NPX_COMMAND } from "./queue.js";
export { NPX_COMMAND } from "./queue.js";
export const COLD_START_COMMAND = `${NPX_COMMAND} init`;

export type InitRepositoryState =
  | "inspect"
  | "not-visible"
  | "selected"
  | "enrolling"
  | "not-ready"
  | "ready"
  | "unreadable";

export type InitKeyState = "inspect" | "missing" | "unregistered" | "registered" | "unreadable";

export interface InitPromptFacts {
  readonly githubName?: string;
  readonly defaultBranch?: string;
  readonly repositoryState?: InitRepositoryState;
  readonly signedIn?: boolean | null;
  readonly keyState?: InitKeyState;
  readonly repositoryDetail?: string;
  readonly keyDetail?: string;
}

function repositoryStep(facts: InitPromptFacts): string {
  const repo = facts.githubName ?? "this repository";
  const branch = facts.defaultBranch ?? "the default branch";
  switch (facts.repositoryState ?? "inspect") {
    case "inspect":
      return "Inspect the live project state from inside the repository. Init reads the GitHub origin and live state before it changes local guidance.";
    case "not-visible":
      return `Thwip could not confirm that ${repo} is selected for your account. Ask a repository administrator to select it at ${SITE}/dashboard. Do not write agent guidance or start queue enrolment from this result.`;
    case "selected":
      return `${repo} is selected in the App but its queue is not enrolled. After this machine and its guidance are ready, open its Queue page at ${SITE}/dashboard. Queue enrolment is a separate, human-guided action.`;
    case "enrolling":
      return `${repo} has incomplete queue enrolment. Repair only this machine and its guidance, then resume the existing Queue setup in the dashboard. Do not start enrolment again or change policy or rulesets from init.`;
    case "not-ready":
      return `${repo} is selected but is not currently ready to use the Queue${facts.repositoryDetail ? `: ${facts.repositoryDetail}` : "."} Prepare this machine and its guidance, then use the project dashboard for the reported repository action. Do not restart enrolment or change GitHub state from init.`;
    case "ready":
      return `${repo} is already enrolled on ${branch}. Prepare only this machine and its agent guidance. Do not run queue setup, change policy, or touch rulesets.`;
    case "unreadable":
      return `Thwip could not safely read the live state for ${repo}${facts.repositoryDetail ? `: ${facts.repositoryDetail}` : "."} Do not change local guidance, adopt the repository, or change queue, policy, or rulesets until that read succeeds.`;
  }
}

function machineStep(facts: InitPromptFacts): string {
  if (facts.signedIn === false) {
    return `The CLI is not signed in. Give me \`${NPX_COMMAND} login\` to run in my own terminal, wait for my browser approval, then rerun init.`;
  }
  switch (facts.keyState ?? "inspect") {
    case "inspect":
      return `Run \`${NPX_COMMAND} keys status\`. Show me the full result.`;
    case "missing":
      return "No signing key was found. Ask me to create one with `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`. Never read or print the private key.";
    case "unregistered":
      return "The local key is not registered with GitHub. Show me its .pub file and send me to https://github.com/settings/ssh/new. I must choose `Signing Key`, not `Authentication Key`.";
    case "registered":
      return "The signing key on this machine is registered with GitHub.";
    case "unreadable":
      return `The signing-key check could not finish${facts.keyDetail ? `: ${facts.keyDetail}` : "."} Stop and report it instead of guessing.`;
  }
}

/** The complete prompt a person pastes into any coding agent. */
export function initPrompt(facts: InitPromptFacts = {}): string {
  return `Set up Thwip in the repository I have open.

Start inside the repository and run:

  ${COLD_START_COMMAND}

If a current global \`thwip\` command already works, \`thwip init\` is the same
entry. Using npx does not install a global command. Init reports the command to
use later; it normally keeps the npx prefix and uses the checkout-local command
inside Thwip's source repository. Init is also the update command. It is safe
to rerun.

Work through these rules:

1. Repository state. ${repositoryStep(facts)}

2. Local guidance. Init may create or refresh only the bounded Thwip section
   in the root AGENTS.md and a small CLAUDE.md pointer to AGENTS.md. It must
   preserve everything outside those regions, show which paths changed, never
   commit them, and produce no diff when it is already current.

3. Machine. ${machineStep(facts)}

4. Check. When the repository is already enrolled, run the exact
   \`doctor --allow-unread\` invocation init wrote in AGENTS.md and report every
   failed or unread check. When enrolment is incomplete, report the exact
   dashboard action a human must take instead of changing GitHub state yourself.

Never read, copy, move, or print a private key. Never weaken a check or change
repository enrolment, policy, rulesets, or GitHub access from init.`;
}

/** Terminal output after the CLI has inspected and, when safe, converged files. */
export function initReport(
  facts: InitPromptFacts,
  result: {
    readonly guidance:
      | { readonly state: "blocked" }
      | {
          readonly state: "current" | "changed";
          readonly paths: readonly string[];
          readonly claudeCompatibility: "managed-file" | "agents-symlink";
          readonly cliCommand: string;
        };
    readonly config: "not-requested" | "unchanged" | "created";
  },
): string {
  const guidance =
    result.guidance.state === "blocked"
      ? "Not checked or changed because repository identity and live state were not confirmed."
      : result.guidance.state === "current"
        ? "Agent guidance is already current."
        : `Updated local guidance: ${result.guidance.paths.join(", ")}. Review and commit these files yourself.`;
  const config =
    result.config === "created"
      ? "Created the explicitly requested thwip.yaml policy candidate. Review it before committing."
      : result.config === "unchanged"
        ? "The explicitly requested thwip.yaml already exists and was unchanged."
        : "No repository policy configuration was requested or changed.";
  const claude =
    result.guidance.state === "blocked"
      ? "Claude compatibility was not checked."
      : result.guidance.claudeCompatibility === "agents-symlink"
        ? "CLAUDE.md already points directly to the root AGENTS.md."
        : "CLAUDE.md's bounded Thwip region contains only a pointer to the canonical AGENTS.md.";
  const command =
    result.guidance.state === "blocked"
      ? "No repository command was selected."
      : `Use \`${result.guidance.cliCommand}\` as the Thwip command in this checkout. Next check: \`${result.guidance.cliCommand} doctor --allow-unread\`.`;
  return `Thwip init checked ${facts.githubName ?? "this repository"}.

Repository: ${repositoryStep(facts)}

Guidance: ${guidance} ${claude}
Configuration: ${config}
Machine: ${machineStep(facts)}
Command: ${command}

Init made no remote GitHub, policy, ruleset, enrolment, or queue changes.`;
}

export * from "./queue.js";
