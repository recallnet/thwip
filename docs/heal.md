# Healing a chain finding

The queue verifies its own chain on every tick and reports what it finds. This
page says what each finding means, what thwip does about it, and what is left
for a person. You should never need to read `mergeOperations` or open D1.

## Where to click

Open the project page. When the branch's record has a finding, a panel sits
above the queue titled **This branch's record**. Each finding shows what it
means, the verifier's own sentence, what recording it would write, and one line
per commit naming the tree and the parents involved. Where thwip can carry the
remedy out there is one button. The reason field starts filled with the
finding, so press it as it stands or say something better first.

Where thwip cannot answer a finding from evidence it holds there is no button,
and the panel says what is left for a person instead.

The panel is for repository admins. Everyone else does not see it.

## The two calls behind it

The panel is these two calls. Reach for them directly when you want the plan in
a terminal.

`GET /v1/queue/:repositoryId/heal?ref=refs/heads/main` verifies the chain and
returns every finding with the remedy thwip computed for it. It writes nothing.
Each finding carries a `summary`, which is the sentence describing what the
button does, and `steps`, which name each commit and what would be recorded for
it.

`POST /v1/queue/:repositoryId/heal?ref=refs/heads/main` takes `{ finding, code,
reason }`. `finding` is the digest from the GET and `code` is that finding's
code. Both are needed because one record can be reported at for two reasons, so
the digest by itself does not say which finding you are answering. Both calls
need repository admin.

You do not supply a tree, a parent list or a commit sha. Those come from GitHub.
An operator who could name a commit could name the throwaway merge GitHub
computes for an open pull request, and record 54 is what recording one of those
produces.

## What thwip does with a finding

### BASE_DISCONTINUITY

The branch moved and no record accounts for the movement. thwip walks first
parents from the far end of the gap back to the near end, which is exactly the
commits that moved the branch, and asks whether a signed merge intent pins each
commit's tree on that commit's parents. The answer decides the remedy.

**One intent pins it.** A merge record is written citing that intent, the same
record `/repair` writes. The attempt is named in the plan so you can see which
turn authorized the merge before you press anything.

**No intent pins it.** The queue never authorized what landed, so no merge
record may claim it did. What gets written is an `external-transition`: the base
moved from one commit to another and the queue did not certify the move. That
record names no pull request, no attempt and no policy, because none of those
are true of it. It is weaker than a merge record on purpose, and the step's
sentence carries the tree and the parents no intent pinned, so you can check the
comparison yourself.

The four merges stranded on 2 August 2026 are all of this shape. Each intent
pinned a base that had already moved, GitHub merged the head onto the real tip,
and the tree it produced is one the queue never pinned.

**Two attempts pin it.** Nothing is written and both attempts are named. thwip
will not choose, because choosing would be a guess wearing a signature. Work out
which attempt merged the commit and call `/repair` with `attemptId` set.

**One attempt's intents disagree.** A merge run that restarts re-signs its
intent, so a commit can carry two intents that both pin it and differ over
something a record repeats. Both digests are named and nothing is written. Read
the two documents, decide which authorization the merge ran under, and record it
by hand.

**The intent is a verified or an override merge.** A verified merge's record
binds the Actions run that verified the candidate and an override's binds an
authorization nothing may reissue, and neither survives in the intent. There is
no button. Close it from the verifier result or the override.

### MISSING_PREFIX, BAD_SIGNATURE, MISSING_RECORD, DIGEST_MISMATCH, BROKEN_LINK, WRONG_SUBJECT

thwip has no remedy for these built from evidence it holds, and the plan says
so rather than offering a button that does nothing useful. A bad signature or a
digest that does not name its own bytes means the stored record disagrees with
itself, which is a question about the store rather than about the branch. Bring
somebody in.

### CHAIN_BEHIND_HEAD

The branch is further on than the last record. The next tick usually closes it
by recording the merge that landed. If it persists, the merge write is stranded
and the discontinuity will appear once a later merge is recorded past it.

## What healing may never do

- Take a tree, a parent list or a commit from whoever asks. Those come from
  GitHub.
- Write a `verified-merge` or `candidate-verified-merge` without the verifier
  result those kinds cite. A verified merge binds an Actions run id no intent
  carries.
- Rewrite or reorder history. A repair appends at the head and takes the next
  sequence, because a record's own position is inside the bytes that were
  signed. Merges put back this way sit at the end of the chain rather than where
  they landed, and the chain reads correctly because each record names the
  commit it moved the base from.
- Resolve a merge write as `CONFIRMED_NOT_MERGED` on anybody's say-so. That
  conclusion needs the corroborated reads `confirmMergeAbsence` performs.

## What is recorded about the heal itself

The record is in the chain under its own kind, so a movement thwip recorded
after the fact never reads as an ordinary merge. The principal who asked is
witnessed on the transition, and the digest of their reason is inside the signed
bytes. The reason text itself is not stored, so keep it in the issue you opened
about the finding if it needs to outlive the call.
