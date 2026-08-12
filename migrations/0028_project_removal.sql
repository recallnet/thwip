-- DEPLOY ORDER: before-worker
-- A removed repository stays visible to the GitHub App, but must not silently
-- become a Thwip project again during installation sync. This marker contains
-- only the minimum identity and actor data needed to enforce that choice.
CREATE TABLE IF NOT EXISTS removed_projects (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  github_repository_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  deleted_by_github_user_id TEXT NOT NULL,
  PRIMARY KEY (organization_id, github_repository_id)
);

-- Content-free audit of the destructive operation. It deliberately carries no
-- repository name, source, proof, policy, queue, commit, or report data.
CREATE TABLE IF NOT EXISTS project_deletion_audits (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  github_repository_id TEXT NOT NULL,
  actor_github_user_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'completed')),
  PRIMARY KEY (organization_id, github_repository_id, requested_at)
);

CREATE INDEX IF NOT EXISTS project_deletion_audits_repository
  ON project_deletion_audits (organization_id, github_repository_id, requested_at);

-- Old queue and verification deliveries may already be in flight when the
-- marker lands. These guards make every repository-keyed projection converge
-- on deletion even when an old delivery reaches D1 after cleanup completed.
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_team_repos
BEFORE INSERT ON team_repos WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_queue_status_comments
BEFORE INSERT ON queue_status_comments WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_queue_runners
BEFORE INSERT ON queue_runners WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_queue_assignments
BEFORE INSERT ON queue_assignments WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_candidate_dispatches
BEFORE INSERT ON candidate_dispatches WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_candidate_verdicts
BEFORE INSERT ON candidate_verdicts WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_queue_attestations
BEFORE INSERT ON queue_attestations WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_queue_transitions_index
BEFORE INSERT ON queue_transitions_index WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_queue_entries_index
BEFORE INSERT ON queue_entries_index WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_queue_projection_marks
BEFORE INSERT ON queue_projection_marks WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_queue_state
BEFORE INSERT ON queue_state WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS removed_project_blocks_queue_projects
BEFORE INSERT ON queue_projects WHEN EXISTS (
  SELECT 1 FROM removed_projects r WHERE r.github_repository_id = NEW.github_repository_id
) BEGIN SELECT RAISE(IGNORE); END;
