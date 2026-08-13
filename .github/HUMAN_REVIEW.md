# Human review rules

Thwip proof shows that a commit passed the configured checks. It does not
replace human judgment where the repository needs it.

## Public contributions

A pull request from a person without trusted write access needs one approval
from a trusted contributor or maintainer. The author cannot approve their own
work. New commits dismiss the approval, and all review conversations must be
resolved before merge. Required status checks and the protected queue still
apply.

Review the current diff and the checks relevant to it. Drafts and small fixes
are welcome. Do not add a blanket code-owner requirement.

## Trusted fast path

Maintainers and trusted contributors may merge routine changes through Thwip
without waiting for another approval. Required status checks, Thwip proof, the
queue, and branch-history protections still apply. Use independent review for
risky, security-sensitive, or unfamiliar changes even when it is not required.

GitHub cannot make a pull-request approval rule depend on whether the author is
trusted. Do not turn on a blanket approval rule and call this policy complete.
Before the repository becomes public, make Thwip check the author's current
repository access and require the approval only when the author lacks trusted
write access. Keep the rule as maintainer policy until that check is live. If
the team prefers GitHub-only enforcement, the simpler fallback is one approval
for every pull request, including maintainers' pull requests.

The separate `Thwip Queue Ownership` ruleset may name the installed Thwip App
as its only bypass actor. Do not give a general bypass to contributors,
administrators, other apps, or GitHub Actions. A temporary emergency bypass
must be recorded, reviewed afterward, and removed as soon as the emergency is
over.

Do not enable GitHub's **Require linear history** rule on a Thwip-owned branch.
Thwip writes two-parent merge commits, so that GitHub rule would block the
queue. Thwip instead serializes base updates and blocks force pushes and
non-fast-forward updates.
