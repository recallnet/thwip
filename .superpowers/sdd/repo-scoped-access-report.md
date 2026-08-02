# Repository-scoped access

People hold repositories they were invited to one at a time, without belonging
to the organization that owns them. thwip could not say that. This is what a
principal became, and what was built on top of it.

## Design

### What a principal is now

A principal row is one person's place inside one organization's world. It is
still unique on `(organization_id, github_user_id)`, and nothing about the table
changed. What changed is what the row is read as.

It used to be read as membership, because that was the only way to be in the
table. It was not. `syncInstallation` has always written a principal for every
outside collaborator, with `github_org_role` set to `'outside'`, so that every
grant row joins to a visible person. So `principals` already held two kinds of
row and one comparison was being used to read both:

```
principals.organization_id = projects.organization_id
```

That comparison was wrong in both directions at once. Someone invited to a
single repository had an `'outside'` principal in the owning organization, so
the comparison passed for every repository that organization owns. Someone with
no row at all was refused a repository GitHub had given them.

The principal is now the identity and `github_org_role` is the scope:

- `owner`, `member`, or a null left by a row written before the column existed:
  membership. Reaches every repository the organization owns.
- `outside`: a collaborator. Reaches exactly the repositories
  `repository_grants` names, at the permission attached to each.

No schema migration. The two facts were already synced and already correct; the
code was reading one of them as the other.

### Authorization

`mayActOnRepository` returned a boolean. `repositoryAccess` returns a level:
`none`, `read`, `write`, `admin`. One query reads the caller's principal role
against the project's organization and the caller's active grant on the project,
and the level is the better of the two answers.

The grant half is keyed by GitHub user id, not by the selected principal,
because a grant belongs to a person. Someone who is a member of Bravo and a
collaborator on an Acme repository would otherwise have to name `?org=acme`
before their own invitation counted for anything. Membership is still read
through the selected principal, so belonging to Bravo is still worth nothing in
Acme.

Permissions map: `admin` to admin; `maintain`, `write`, `push` to write;
`triage`, `read`, `pull` to read; anything unrecognized to none. The column is
free text synced from GitHub, and a permission this deployment has not heard of
is not a reason to guess upward.

`write` is the floor for queueing, because it is the floor GitHub puts on
pushing, and because the walk to a merge already refuses a sponsor who does not
hold admin, maintain or write. One rule checked in two places rather than two
rules that drift.

### The route table

`REPOSITORY_ACCESS` keyed the segment after the repository id to one of
`workflow | either | route`, defaulting to membership. It now maps to a
requirement carrying both the identity it accepts and the level it needs, and
the default is `write`. Read is granted by name to the two segments that read:
the queue itself and `explain`. `candidate` keeps its either-identity and asks
for read; `nudge` keeps its either-identity and asks for write, because it
dispatches Actions.

The default staying the strictest is the point of the table. A route added and
not listed needs write, which is stricter than it was under membership for a
triage collaborator and identical for everyone else.

`isAdmin` is now set by the gate from the resolved level rather than taken from
`authenticate`. Read off the session it was a claim about whichever organization
the session selected, and it says nothing at all about somebody who holds this
repository and belongs to no organization.

### `?org=` and the dashboard

For someone in no organization, `?org=` selects nothing, and that is what makes
the rest safe. `resolveViewer` splits its rows: `orgs` is memberships only, and
the selected principal may be a collaborator row, in which case `organizationId`
is null. Every organization-wide read in the dashboard already refuses a viewer
without an `organizationId`, so a collaborator is refused the member list, the
seat counts and the organization's settings by the guard that was already on
each of them. Adding a check to each of those routes is what the queue gate was
built to stop.

Selection prefers a membership when `?org=` names nothing or names an
organization the viewer is not in, so a stale link cannot quietly drop somebody
into their collaborator scope and empty their dashboard.

`/v1/dashboard/projects` unions the two reaches and labels each row `member` or
`collaborator` with the permission that reached it. Someone in no organization
gets exactly their granted repositories. Someone who is both a member of one
organization and a collaborator on another organization's repository gets their
organization's projects plus that repository, without switching organizations to
find it.

### Verification is untouched

A commit authored by a non-member verifies identically. The proof is trusted
because the signing key is published on the author's GitHub account and they
held repository permission when it merged, and both are already checked.
Nothing here adds a membership signal to verification.

## What was built

- `apps/control-plane/src/queue/repository-access.ts`: `repositoryAccess`
  returning a level, `atLeast`, the permission map, `isOrganizationMember`, and
  a second refusal string for a caller who holds the repository and not the
  permission.
- `apps/control-plane/src/queue/routes.ts`: the requirement table and the gate.
- `apps/control-plane/src/viewer-scope.ts`: which principal a session acts as,
  and whether that principal is a membership.
- `apps/control-plane/src/dashboard-scope.ts`: the projects one viewer reaches.
- `apps/control-plane/src/index.ts`: `resolveViewer` splits memberships from
  collaborator rows; the project list stops requiring an organization.

### The disclosure boundary

A 404 is a member's answer, not a stranger's. Nothing here changes that. The
gate emits the existing `REPOSITORY_FORBIDDEN`, unchanged, for a caller whose
level is `none`, and that is the same answer byte for byte as for a repository
nobody has onboarded. Three tests pin it: a collaborator on another repository
of the same organization, a collaborator whose grant was withdrawn, and a member
of another organization each get a response identical to the one for an absent
repository id.

The second refusal is emitted only after the caller has cleared read, which
means GitHub already told them the repository exists when it sent the
invitation. Naming the permission they are short of at that point discloses
nothing new, and a triage collaborator told "not a member of the organization"
would go looking for an organization they are right not to be in.

### What the operator still has to do

The GitHub App is registered `public: false`. A private App is visible only to
members of the organization that owns it, so GitHub answers its authorize page
with a 404 for everybody else, and an outside collaborator cannot sign in at all
regardless of what the control plane will serve them. The manifest now says
`public: true`, which fixes the next registration and nothing else.

**The running App has to be flipped to public in its own settings by its owner.**
Until that happens, none of this is reachable by the people it is for.

### Left alone, deliberately

Enabling and disabling a project, and changing its proof mode, still require an
organization. They move plan-limited state and the seat and project limits
belong to the organization, so a collaborator holding repository admin can queue
and administer the queue but not change what the organization is billed for.

## Verification

New tests before the implementation: 6 failed, 6 passed, and two files failed to
load because the modules did not exist yet.

After: `pnpm vitest run` is 122 files and 1806 tests passing, from 119 files and
1779 tests. `pnpm typecheck` clean. `node scripts/lint.mjs` reports ok.
