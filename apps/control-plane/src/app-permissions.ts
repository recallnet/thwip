/**
 * What the App has to be granted, in one place.
 *
 * There were two lists. `queueDoctor` checked an installation against `checks`,
 * `contents`, `pull_requests` and `statuses`, all write, and reported `canMerge`
 * off it. The App manifest a few hundred lines away asked for `contents: read`,
 * `pull_requests: read` and no `statuses` at all, so an App registered from that
 * manifest failed the diagnostic in the same file that wrote it. The manifest
 * describes a fresh registration and nothing else, which is why nobody found out
 * from an installation that already worked.
 *
 * `contents: write` is what performs the merge: writing the commit object and
 * moving the branch ref are both Contents, and `managedOwnershipRuleset` already
 * names the App as the only actor allowed to update a managed branch. The
 * repository_dispatch the queue drives lanes with is Contents: write too.
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
