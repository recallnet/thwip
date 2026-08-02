-- DEPLOY ORDER: before-worker
-- GitHub organization projection extensions: installation linkage, org roles,
-- Better Auth linkage, teams, team membership, and team repo permissions.
ALTER TABLE organizations ADD COLUMN installation_id TEXT;
ALTER TABLE organizations ADD COLUMN better_auth_org_id TEXT;
ALTER TABLE principals ADD COLUMN github_org_role TEXT;
ALTER TABLE principals ADD COLUMN avatar_url TEXT;
ALTER TABLE principals ADD COLUMN better_auth_user_id TEXT;

CREATE TABLE github_teams (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  team_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (organization_id, team_id)
);

CREATE TABLE team_members (
  organization_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  github_user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (organization_id, team_id, github_user_id)
);

CREATE TABLE team_repos (
  organization_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  github_repository_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (organization_id, team_id, github_repository_id)
);

CREATE INDEX idx_principals_ba_user ON principals(better_auth_user_id);
CREATE INDEX idx_orgs_installation ON organizations(installation_id);
