# Set up your machine for thwip

Paste the block below into your coding agent, or run `thwip setup` to print
it. It installs the CLI, signs you in with a device code that works over SSH,
and guides you through registering a signing key with GitHub. The agent never
handles your private key.

Setting up a *repository* is a separate prompt, on that project's page in the
dashboard.

```
Set up my machine to sign thwip proofs (https://thwip.recall.net).

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
       a. Open https://github.com/settings/ssh/new
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
project's page at https://thwip.recall.net/dashboard/projects.
```
