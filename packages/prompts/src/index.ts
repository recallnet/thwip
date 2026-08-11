/**
 * Agent prompts, shared by the dashboard, the CLI, and the published
 * markdown so the three cannot drift. Two distinct jobs:
 *
 *   developerSetupPrompt — prepare a machine to sign proofs
 *   projectSetupPrompt   — put one repository on thwip
 */

export const SITE = "https://thwip.recall.net";

/**
 * Preparing a developer machine. Written so the agent never touches the
 * private key and never guesses at the GitHub steps that are easy to get
 * wrong: the account the key must go on, and the key type.
 */
export function developerSetupPrompt(): string {
  return `Set up my machine to sign thwip proofs (${SITE}).

Ground rules: ask me before anything that changes files or my GitHub account,
and never read, copy, move, or print the contents of a private key. You may
read and print .pub files. If a step needs my browser or my terminal, hand me
the exact command or URL and wait.

1. CLI. Check that "thwip --help" works. If it doesn't, install it:
     npm install -g @recallnet/thwip
   Node 22 or newer is required. The installed command is "thwip". To skip a
   global install, "npx @recallnet/thwip" works wherever this prompt says
   "thwip".

2. Sign in. Don't run this yourself — "thwip login" blocks until I approve it
   in a browser, and the browser has to be mine. Give me a pastable command to
   run in my own terminal:
     thwip login
   It prints a URL and a short code. I'll open it, approve, and tell you when
   it reports "signed in". Wait for that before continuing.

3. Signing key. Run "thwip keys status" and show me the whole output. It
   reports which key on this machine would sign, and whether GitHub lists that
   key as a signing key for the account the CLI authenticates as. Then:

   - registeredWithGithub: true — done, go to step 4.

   - No key found at all: propose this and let me run it myself, so the private
     key is created by me and stays out of your context:
       ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519
     Then continue to the registration steps below.

   - A key exists but isn't registered: print the public half for me to copy
       cat ~/.ssh/id_ed25519.pub
     and give me these instructions, which are easy to get wrong in two
     specific ways:
       a. Open ${"https://github.com/settings/ssh/new"}
       b. Check the account shown on that page matches the "githubLogin" value
          from "thwip keys status". Registering the key on a different GitHub
          account will not work, because the verifier reads the signing keys of
          the account the proof names.
       c. Set "Key type" to "Signing Key". It defaults to "Authentication Key",
          which GitHub keeps in a separate list that thwip does not read. This
          is the most common mistake.
       d. Paste the key, give it a title, and add it.
       e. If GitHub answers "key is already in use", that key is registered on
          another account. Either sign in as the account from (b), or generate
          a new key and start again.

   - Re-run "thwip keys status" and confirm registeredWithGithub is now true
     before continuing.

4. Report back: the fingerprint that will appear in my proofs, the GitHub
   account they will be attributed to, and which local key file it came from.

That's the machine ready. Setting up a repository is a separate prompt, in the
project's page at ${SITE}/dashboard/projects.`;
}

export interface ProjectPromptFacts {
  githubName: string;
  defaultBranch: string;
  enabled: boolean;
  hasActivePolicy: boolean;
}

/** Putting one repository on thwip, assuming the machine is already set up. */
export function projectSetupPrompt(p: ProjectPromptFacts): string {
  const finish = !p.enabled
    ? `This project is currently disabled in thwip. Tell me to enable it at ${SITE}/dashboard/projects (I need repository admin on GitHub) before expecting the thwip check to pass. ${
        p.hasActivePolicy
          ? "Its recorded active policy applies again when the project is enabled; until then the resolver reports PROJECT_DISABLED."
          : `Once enabled, organization defaults can activate immediately. If this repository instead needs a thwip.yaml override, it activates only from canonical ${p.defaultBranch} after review and merge. Until an effective policy exists, BOOTSTRAP_PENDING is informational and does not approve a candidate policy or proof.`
      }`
    : p.hasActivePolicy
      ? "The project is already enabled and a policy is active. This pull request is verified under that policy. A changed thwip.yaml override takes effect only after its protected merge lands. The thwip check should pass from the proof on the head commit, without rerunning the suites in the cloud."
      : `The project is already enabled, but no policy is active yet. Configure organization defaults in the dashboard or merge a thwip.yaml override into canonical ${p.defaultBranch}. BOOTSTRAP_PENDING is informational and does not approve this pull request's candidate policy or proof. Later pull requests are verified under the active effective policy; a candidate policy never approves itself.`;

  return `Set up thwip (verified local CI) for ${p.githubName}. Work through this in
order and ask me before anything that changes files, deletes workflows, or
pushes. This is safe to re-run: if a step is already done, say so and move on.

0. Machine. Run "thwip keys status". If the command is missing, or it reports
   registeredWithGithub: false, stop and use the developer setup prompt at
   ${SITE}/install first — this repository can't be set up until this machine
   can sign.

1. Effective configuration. Run "thwip policy digest" and show me its
   configSource, required checks, profile, and digests. Organization defaults
   are preferred for ordinary repositories and need no repository file. If
   this repository differs, propose the smallest partial thwip.yaml override;
   committed fields override organization defaults only after they reach
   canonical ${p.defaultBranch}, so a pull request cannot approve itself.
   If neither source exists, propose which checks make up CI here — typically
   lint, typecheck, test — and either ask an organization owner to set defaults
   or run:
     thwip init --required "<the ids you proposed>"
   Suite ids name package.json scripts by default. If this repo has, or wants,
   a Dagger module, say so: a module is the better home for matrices,
   services, and platforms. Anything that cannot run in a Linux container —
   macOS or Windows builds — goes under \`remote:\` instead, and GitHub runs
   and signs those. Show me any proposed thwip.yaml before continuing.

2. Local push warning. Offer to install Thwip's managed, non-blocking pre-push
   warning. Explain that it covers this repository's main worktree and every
   linked worktree, always allows deliberate low-level Git, and never overwrites
   a pre-push hook Thwip does not manage. Only after I explicitly approve, run:
     thwip setup --install-push-warning
   If I decline, continue without it.

3. Prove and ship it. Commit configuration changes on a branch, then run
   "thwip ship --wait". This is the complete path: it runs the suites, attaches
   a signed proof to HEAD, pushes, opens or updates the pull request, joins the
   queue, and waits for the outcome. If the goal is only to create or refresh a
   proof without shipping, "thwip run" remains the proof-only command. If
   either command refuses to sign, tell me the reason it printed rather than
   working around it. Keep the current required check unchanged while the
   App-owned "thwip / proof (observe)" check proves the same exact PR head
   successfully.

4. Cut over the gate. After at least one observe-mode PASS, ask me to switch
   this project to "Enforce App check" in the dashboard. Update the GitHub
   ruleset so the Actions-owned "thwip / workflow" requirement is replaced by
   the App-owned "thwip" context, then confirm the App-owned check passes on a
   fresh commit before removing any verifier workflow. Do not leave an unprotected interval.

5. Retire duplicated remote CI. Read .github/workflows/*. List every job and
   sort it into:
     - now proven locally by thwip (the same lint/typecheck/test work) —
       candidates for removal
     - must stay remote (deploy, release, publish, scheduled jobs, anything
       needing cloud secrets, anything that runs on a schedule or on main)
     - unclear — ask me
   Show me the list with your reasoning and wait for my decision on each
   candidate before editing or deleting anything. Removing CI is the one step
   I want to review carefully.

6. Finish. ${finish}

Rules: never move a private key anywhere outside my ~/.ssh or ~/.config/thwip;
never skip or weaken a failing check to get a green proof; the default branch
here is ${p.defaultBranch}.`;
}
export * from "./queue.js";
