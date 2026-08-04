/**
 * What the App has to be granted, in one place.
 *
 * There were two lists. `queueDoctor` checked an installation against `checks`,
 * `contents`, `pull_requests` and `statuses`, all write, while the App manifest
 * asked for `contents: read`, `pull_requests: read` and no `statuses`. A fresh
 * registration therefore failed the diagnostic written beside its manifest.
 *
 * `contents: write` is what performs the merge: writing the commit object and
 * moving the branch ref are both Contents, and `managedOwnershipRuleset` already
 * names the App as the only actor allowed to update a managed branch. The
 * repository_dispatch the queue drives lanes with is Contents: write too.
 *
 * `issues: write` is deliberately absent, and the reason is worth keeping. The
 * status comment goes to `/issues/{n}/comments`, which reads as an Issues
 * endpoint, so this list asked for the scope for one afternoon. Then the App
 * wrote a status comment on recallnet/thwip pull request 180 while holding no
 * `issues` scope at all: GitHub counts a pull request's conversation under Pull
 * requests, whatever the path spells. Keeping the demand would have reported
 * every installation as broken while every installation commented fine, on the
 * diagnostic somebody runs when the queue is stuck, which is where a false
 * alarm costs the most. `canComment` reads off `pull_requests` because that is
 * what actually carries the comment.
 *
 * Ruleset reads use the existing Metadata permission. Ruleset writes stay with
 * a repository administrator: GitHub's only App scope for them is the broad
 * `administration: write`, which also grants unrelated repository-management
 * authority that the runtime queue does not need.
 */
export const REQUIRED_APP_PERMISSIONS: Readonly<Record<string, string>> = {
  checks: "write",
  contents: "write",
  pull_requests: "write",
  statuses: "write",
};

/**
 * The rest of what a registration asks for: reading who a person is, so they can
 * sign in, and reading the organization they belong to. None of it writes.
 */
const SIGN_IN_PERMISSIONS: Readonly<Record<string, string>> = {
  emails: "read",
  members: "read",
  metadata: "read",
};

/** What the manifest declares. The same list, never a copy of it. */
export const APP_MANIFEST_PERMISSIONS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({ ...REQUIRED_APP_PERMISSIONS, ...SIGN_IN_PERMISSIONS }).sort(([a], [b]) =>
    a.localeCompare(b),
  ),
);
