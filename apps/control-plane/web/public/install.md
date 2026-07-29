# Install thwip (agent prompt)

Paste the block below into your coding agent. It installs the CLI, signs in
with a click-through device code (works over SSH: the URL is clicked on the
human's machine), and sets up the project with the human's approval at each
step.

```
You are installing thwip (verified local CI) into this project.
Work step by step and ask the human before each side-effectful step.

1. Install the CLI: clone https://github.com/recallnet/thwip and run
   "pnpm install && pnpm build", then link packages/cli (or run it via
   "node packages/cli/dist/main.js"). Confirm with: thwip --help
2. Authenticate: do not run this yourself. "thwip login" blocks until a
   human approves it in a browser, and the browser must be theirs. Give
   them a pastable command to run in their own terminal:
     thwip login
   It prints a URL and a short code; they open it, approve, and tell you
   when it reports "signed in". Wait for that confirmation before
   continuing.
3. Enroll this machine's signing key: generate a dedicated key with
   "ssh-keygen -t ed25519 -f ~/.config/thwip/keys/<device> -N ''" after
   asking the human to name the device, then run
   "thwip keys enroll --public-key ~/.config/thwip/keys/<device>.pub --label <device>".
4. Set up the project: ask the human which checks make up CI here
   (for example lint, typecheck, test), then write thwip.yaml at the
   repository root declaring those suites and the security profile
   (start with "fast"; see https://thwip.recall.net/faq for profiles).
   Commit it on a branch and open a pull request.
5. Ask the human (an org owner) to enable the project and activate the
   policy in the dashboard at https://thwip.recall.net/dashboard.
6. Prove the loop: make a small change, run "thwip run", push, and
   open a PR. The thwip check should pass from the proof on the head
   commit without rerunning CI remotely.

Rules: never generate or upload a private key anywhere except the
human's ~/.config/thwip directory; never bypass a failing suite; if
"thwip run" refuses to sign, report the reason code to the human
instead of working around it.
```
