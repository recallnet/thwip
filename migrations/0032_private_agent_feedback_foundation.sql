-- DEPLOY ORDER: before-worker
-- DEPLOY BLOCKER: 0031 must first complete the operator-approved #398 Phase 2
-- D1 cutover. The migration runner must refuse this file while 0031 is gated.
-- Private agent feedback is dark in this migration. It creates only the
-- project-scoped storage and retention foundation; no API route uses it yet.

-- This is the only row that may survive private content deletion. Its columns
-- deliberately contain no project, repository, organization, or person key.
CREATE TABLE agent_report_receipts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN (
    'awaiting_approval', 'submitted', 'rejected', 'closed',
    'published', 'publication_unknown'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  final_at TEXT,
  content_deleted_at TEXT,
  expires_at TEXT NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_agent_report_receipts_expiry
  ON agent_report_receipts(expires_at, id);

-- The private root is a fresh project-incarnation child. Deleting it removes
-- all report-derived text, provenance, and audit detail in one cascade.
CREATE TABLE agent_report_private_roots (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE
    REFERENCES agent_report_receipts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  payload_binding TEXT NOT NULL
    CHECK (length(payload_binding) = 79 AND payload_binding LIKE 'hmac-sha256:v1:%'),
  submitted_at TEXT NOT NULL,
  delete_at TEXT NOT NULL,
  CHECK (delete_at > submitted_at)
);

CREATE INDEX idx_agent_report_private_roots_project
  ON agent_report_private_roots(project_id, id);
CREATE INDEX idx_agent_report_private_roots_deletion
  ON agent_report_private_roots(delete_at, id);

CREATE TABLE agent_report_content (
  private_root_id TEXT PRIMARY KEY
    REFERENCES agent_report_private_roots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bug', 'feature')),
  title TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE agent_report_provenance (
  private_root_id TEXT PRIMARY KEY
    REFERENCES agent_report_private_roots(id) ON DELETE CASCADE,
  better_auth_user_id TEXT NOT NULL,
  github_user_id TEXT NOT NULL
    CHECK (length(github_user_id) > 0 AND github_user_id NOT GLOB '*[^0-9]*'),
  github_installation_id TEXT NOT NULL
    CHECK (length(github_installation_id) > 0 AND github_installation_id NOT GLOB '*[^0-9]*'),
  github_repository_id TEXT NOT NULL
    CHECK (length(github_repository_id) > 0 AND github_repository_id NOT GLOB '*[^0-9]*'),
  cli_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);

CREATE TABLE agent_report_events (
  id TEXT PRIMARY KEY,
  private_root_id TEXT NOT NULL
    REFERENCES agent_report_private_roots(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('submitter', 'operator', 'system')),
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_agent_report_events_root_time
  ON agent_report_events(private_root_id, occurred_at, id);

CREATE TABLE agent_report_retention_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  claim_token TEXT,
  claim_expires_at TEXT,
  last_started_at TEXT,
  last_finished_at TEXT,
  last_error_at TEXT,
  last_error TEXT
);

INSERT INTO agent_report_retention_clock (id) VALUES (1);

-- A private root can be created only while an exact, active project
-- incarnation has a live #398 writer lease. A release request fences it before
-- cleanup starts, including during repository remove/re-add races.
CREATE TRIGGER agent_report_private_root_requires_project_lease
BEFORE INSERT ON agent_report_private_roots
WHEN NOT EXISTS (
  SELECT 1
    FROM projects project
    JOIN organizations organization ON organization.id = project.organization_id
    JOIN project_write_leases lease
      ON lease.github_repository_id = project.github_repository_id
     AND lease.project_id = project.id
     AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE project.id = NEW.project_id
     AND organization.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM project_release_requests request
        WHERE request.github_repository_id = project.github_repository_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM project_release_jobs job
        WHERE job.github_repository_id = project.github_repository_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'private feedback project unavailable');
END;

CREATE TRIGGER agent_report_private_root_is_immutable
BEFORE UPDATE ON agent_report_private_roots
BEGIN
  SELECT RAISE(ABORT, 'private feedback root identity is immutable');
END;

-- Provenance must name the same live GitHub installation and numeric repository
-- as the project incarnation. The Phase 2 route will additionally prove the
-- numeric GitHub user has current write access before this insert.
CREATE TRIGGER agent_report_provenance_matches_project
BEFORE INSERT ON agent_report_provenance
WHEN NOT EXISTS (
  SELECT 1
    FROM agent_report_private_roots root
    JOIN projects project ON project.id = root.project_id
    JOIN organizations organization ON organization.id = project.organization_id
    JOIN project_write_leases lease
      ON lease.github_repository_id = project.github_repository_id
     AND lease.project_id = project.id
     AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE root.id = NEW.private_root_id
     AND project.github_repository_id = NEW.github_repository_id
     AND organization.installation_id = NEW.github_installation_id
     AND NOT EXISTS (
       SELECT 1 FROM project_release_requests request
        WHERE request.github_repository_id = project.github_repository_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM project_release_jobs job
        WHERE job.github_repository_id = project.github_repository_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'private feedback provenance does not match project');
END;

CREATE TRIGGER agent_report_content_is_immutable
BEFORE UPDATE ON agent_report_content
BEGIN
  SELECT RAISE(ABORT, 'private feedback content is immutable');
END;

CREATE TRIGGER agent_report_content_requires_project_lease
BEFORE INSERT ON agent_report_content
WHEN NOT EXISTS (
  SELECT 1
    FROM agent_report_private_roots root
    JOIN projects project ON project.id = root.project_id
    JOIN project_write_leases lease
      ON lease.github_repository_id = project.github_repository_id
     AND lease.project_id = project.id
     AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE root.id = NEW.private_root_id
     AND NOT EXISTS (
       SELECT 1 FROM project_release_requests request
        WHERE request.github_repository_id = project.github_repository_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM project_release_jobs job
        WHERE job.github_repository_id = project.github_repository_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'private feedback project unavailable');
END;

CREATE TRIGGER agent_report_provenance_is_immutable
BEFORE UPDATE ON agent_report_provenance
BEGIN
  SELECT RAISE(ABORT, 'private feedback provenance is immutable');
END;

CREATE TRIGGER agent_report_event_requires_project_lease
BEFORE INSERT ON agent_report_events
WHEN NOT EXISTS (
  SELECT 1
    FROM agent_report_private_roots root
    JOIN projects project ON project.id = root.project_id
    JOIN project_write_leases lease
      ON lease.github_repository_id = project.github_repository_id
     AND lease.project_id = project.id
     AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE root.id = NEW.private_root_id
     AND NOT EXISTS (
       SELECT 1 FROM project_release_requests request
        WHERE request.github_repository_id = project.github_repository_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM project_release_jobs job
        WHERE job.github_repository_id = project.github_repository_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'private feedback project unavailable');
END;
