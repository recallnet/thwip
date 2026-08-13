-- DEPLOY ORDER: before-worker
-- GitHub App repository selection is the project lifecycle. A release job is
-- a short-lived lock while D1, R2 and the retired queue object are cleaned.
-- It is removed in the same D1 batch that removes the project, so a repository
-- selected again later starts as a new disabled project with no retained
-- exclusion record.
CREATE TABLE IF NOT EXISTS project_release_requests (
  github_repository_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  github_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_attempted_at TEXT
);

CREATE TABLE IF NOT EXISTS project_release_jobs (
  github_repository_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  github_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  queue_refs_seeded INTEGER NOT NULL DEFAULT 0 CHECK (queue_refs_seeded IN (0, 1)),
  evidence_scopes_seeded INTEGER NOT NULL DEFAULT 0 CHECK (evidence_scopes_seeded IN (0, 1)),
  cleanup_owner_token TEXT,
  cleanup_lease_expires_at TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS project_release_jobs_organization
  ON project_release_jobs (organization_id, started_at);

CREATE TABLE IF NOT EXISTS project_release_queue_refs (
  project_id TEXT NOT NULL,
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  PRIMARY KEY (project_id, base_ref),
  FOREIGN KEY (github_repository_id) REFERENCES project_release_jobs(github_repository_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_release_queue_refs_repository
  ON project_release_queue_refs (github_repository_id, project_id, base_ref);

-- A repository may have legacy tombstones in more than one tenant after a
-- transfer. Each tenant has its own R2 prefix, so keep every prefix until the
-- transient release job has drained it.
CREATE TABLE IF NOT EXISTS project_release_evidence_scopes (
  github_repository_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, prefix),
  FOREIGN KEY (github_repository_id) REFERENCES project_release_jobs(github_repository_id) ON DELETE CASCADE
);

-- R2 is an external capability, so a clock expiry cannot prove that a paused
-- put has stopped. Every intent names the bucket generation whose binding
-- started the write. A `writing` intent is drainable only after an operator has
-- deleted that generation's bucket and recorded the hard capability boundary.
-- A later deployment writes through one different active generation.
CREATE TABLE IF NOT EXISTS project_r2_capability_generations (
  generation TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retired_at TEXT,
  retirement_evidence TEXT,
  CHECK (
    (state = 'active' AND retired_at IS NULL AND retirement_evidence IS NULL)
    OR (state = 'retired' AND retired_at IS NOT NULL AND length(retirement_evidence) > 0)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS project_r2_one_active_generation
  ON project_r2_capability_generations (state) WHERE state = 'active';
INSERT OR IGNORE INTO project_r2_capability_generations (generation, state)
VALUES ('phase-1-existing-bucket', 'active');

-- An R2 request can finish after the project lease that started it expires.
-- Record the exact object and project before put() begins. This row has no
-- project foreign key on purpose: cleanup must survive deletion of the project
-- and release job. A live writer renews its lease. A writer that returned from
-- put marks cleanup; an uncertain writing intent remains a hard fence until its
-- bucket generation is retired.
CREATE TABLE IF NOT EXISTS project_r2_cleanup_intents (
  object_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  github_repository_id TEXT NOT NULL,
  capability_generation TEXT NOT NULL DEFAULT 'phase-1-existing-bucket',
  state TEXT NOT NULL DEFAULT 'writing' CHECK (state IN ('writing', 'cleanup')),
  owner_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_attempted_at TEXT,
  FOREIGN KEY (capability_generation) REFERENCES project_r2_capability_generations(generation)
);
CREATE INDEX IF NOT EXISTS project_r2_cleanup_intents_project
  ON project_r2_cleanup_intents (project_id, state, lease_expires_at);
CREATE INDEX IF NOT EXISTS project_r2_cleanup_intents_due
  ON project_r2_cleanup_intents (state, lease_expires_at, created_at);

-- A legacy tombstone can outlive a repository transfer. If its tenant no
-- longer owns the live project, only that tenant's old R2 prefix and
-- tenant-keyed repository rows are safe to purge. It must never create a
-- repository-wide release fence for the new owner.
CREATE TABLE IF NOT EXISTS project_legacy_cleanup_scopes (
  github_repository_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_attempted_at TEXT,
  cleanup_owner_token TEXT,
  cleanup_lease_expires_at TEXT,
  PRIMARY KEY (github_repository_id, organization_id)
);

-- Installation authority is staged before it replaces live membership/team
-- projections. Large organizations are written in bounded batches; the live
-- authorization view changes only in the small final transaction after every
-- stable GitHub list is present.
CREATE TABLE IF NOT EXISTS github_sync_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  owner_token TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'repositories',
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  cursor_kind TEXT NOT NULL DEFAULT 'repositories',
  cursor_parent TEXT,
  cursor_page INTEGER NOT NULL DEFAULT 1 CHECK (cursor_page >= 1),
  installation_authority TEXT NOT NULL DEFAULT '{}',
  repository_count INTEGER,
  publication_ready INTEGER NOT NULL DEFAULT 0 CHECK (publication_ready IN (0, 1)),
  continuation_pending INTEGER NOT NULL DEFAULT 0 CHECK (continuation_pending IN (0, 1)),
  continuation_not_before TEXT,
  post_sync_policy_reconcile INTEGER NOT NULL DEFAULT 0 CHECK (post_sync_policy_reconcile IN (0, 1)),
  post_sync_proof_reconcile INTEGER NOT NULL DEFAULT 0 CHECK (post_sync_proof_reconcile IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (continuation_pending = 0 AND continuation_not_before IS NULL)
    OR (continuation_pending = 1 AND continuation_not_before IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS github_sync_repositories (
  snapshot_id TEXT NOT NULL,
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  github_repository_id TEXT NOT NULL,
  github_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, authority_pass, github_repository_id),
  FOREIGN KEY (snapshot_id) REFERENCES github_sync_snapshots(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS github_sync_people (
  snapshot_id TEXT NOT NULL,
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  github_org_role TEXT NOT NULL,
  avatar_url TEXT,
  PRIMARY KEY (snapshot_id, authority_pass, github_user_id),
  FOREIGN KEY (snapshot_id) REFERENCES github_sync_snapshots(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS github_sync_teams (
  snapshot_id TEXT NOT NULL,
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  team_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, authority_pass, team_id),
  FOREIGN KEY (snapshot_id) REFERENCES github_sync_snapshots(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS github_sync_team_members (
  snapshot_id TEXT NOT NULL,
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  team_id TEXT NOT NULL,
  github_user_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, authority_pass, team_id, github_user_id),
  FOREIGN KEY (snapshot_id) REFERENCES github_sync_snapshots(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS github_sync_team_repos (
  snapshot_id TEXT NOT NULL,
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  team_id TEXT NOT NULL,
  github_repository_id TEXT NOT NULL,
  project_id TEXT,
  permission TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, authority_pass, team_id, github_repository_id),
  FOREIGN KEY (snapshot_id) REFERENCES github_sync_snapshots(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS github_sync_grants (
  snapshot_id TEXT NOT NULL,
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  github_repository_id TEXT NOT NULL,
  project_id TEXT,
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, authority_pass, github_repository_id, github_user_id),
  FOREIGN KEY (snapshot_id) REFERENCES github_sync_snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS github_sync_snapshots_installation
  ON github_sync_snapshots (installation_id, created_at);

-- A complete installation snapshot owns repository lifecycle authority only
-- after its final GitHub pass. This prevents a delayed sync from releasing or
-- importing a repository now owned by another installation or tenant.
CREATE TABLE IF NOT EXISTS github_repository_authority (
  github_repository_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (github_repository_id, installation_id)
);
CREATE TABLE IF NOT EXISTS github_repository_reconcile_leases (
  github_repository_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  expires_at TEXT NOT NULL
);

-- GitHub installation tokens may live for one hour. A removed repository can
-- be selected immediately, but a clean project incarnation is not imported
-- until every token minted before removal has expired. This row is transient
-- and is deleted by the import that consumes it.
CREATE TABLE IF NOT EXISTS project_reimport_quarantines (
  github_repository_id TEXT PRIMARY KEY,
  prior_project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  reimport_not_before TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Carry any incomplete cleanup from the superseded tombstone model into a
-- transient release job before deleting the permanent identity. Rows whose
-- project was already deleted still need one final bounded R2/D1 sweep.
-- Bind a tombstone only to the exact tenant project it removed. A matching
-- repository that has since transferred to another tenant is unrelated.
INSERT OR IGNORE INTO project_release_jobs
  (github_repository_id, project_id, organization_id, github_name, default_branch, started_at)
SELECT p.github_repository_id, p.id, p.organization_id, p.github_name,
       p.default_branch, MIN(r.deleted_at)
  FROM projects p JOIN removed_projects r
    ON r.github_repository_id = p.github_repository_id
   AND r.organization_id = p.organization_id
 GROUP BY p.github_repository_id, p.id, p.organization_id, p.github_name, p.default_branch;

-- A tombstone with no exact live tenant project gets a narrow legacy sweep.
-- This never owns or blocks a project that another tenant selected later.
INSERT OR IGNORE INTO project_legacy_cleanup_scopes
  (github_repository_id, organization_id, started_at)
SELECT r.github_repository_id, r.organization_id, r.deleted_at
  FROM removed_projects r
 WHERE NOT EXISTS (
   SELECT 1 FROM projects p
    WHERE p.github_repository_id = r.github_repository_id
      AND p.organization_id = r.organization_id
 );

INSERT OR IGNORE INTO project_release_evidence_scopes (github_repository_id, prefix)
SELECT r.github_repository_id, 'org/' || r.organization_id || '/repo/' || r.github_repository_id || '/'
  FROM removed_projects r
  JOIN project_release_jobs j
    ON j.github_repository_id = r.github_repository_id
   AND j.organization_id = r.organization_id;

INSERT OR IGNORE INTO project_release_evidence_scopes (github_repository_id, prefix)
SELECT github_repository_id, 'project/' || project_id || '/'
  FROM project_release_jobs;

UPDATE project_release_jobs SET evidence_scopes_seeded = 1
 WHERE EXISTS (
   SELECT 1 FROM removed_projects r
    WHERE r.github_repository_id = project_release_jobs.github_repository_id
      AND r.organization_id = project_release_jobs.organization_id
 );

INSERT OR IGNORE INTO project_release_requests
  (github_repository_id, project_id, organization_id, github_name, default_branch, requested_at)
SELECT github_repository_id, project_id, organization_id, github_name, default_branch, started_at
  FROM project_release_jobs;

-- A still-live previous Worker can create another tombstone after this
-- additive migration. Mirror that write immediately into the transient
-- lifecycle tables. Its retired restore endpoint then cannot delete the
-- tombstone and revive an enabled project before 0031 applies.
CREATE TRIGGER project_release_captures_late_tombstone
AFTER INSERT ON removed_projects
BEGIN
  INSERT OR IGNORE INTO project_release_jobs
    (github_repository_id, project_id, organization_id, github_name, default_branch, started_at)
  SELECT NEW.github_repository_id, p.id, p.organization_id, p.github_name,
         p.default_branch, NEW.deleted_at
    FROM projects p
   WHERE p.github_repository_id = NEW.github_repository_id
     AND p.organization_id = NEW.organization_id;

  INSERT OR IGNORE INTO project_legacy_cleanup_scopes
    (github_repository_id, organization_id, started_at)
  SELECT NEW.github_repository_id, NEW.organization_id, NEW.deleted_at
   WHERE NOT EXISTS (
     SELECT 1 FROM projects p
      WHERE p.github_repository_id = NEW.github_repository_id
        AND p.organization_id = NEW.organization_id
   );

  INSERT OR IGNORE INTO project_release_evidence_scopes
    (github_repository_id, prefix)
  SELECT NEW.github_repository_id,
         'org/' || NEW.organization_id || '/repo/' || NEW.github_repository_id || '/'
   WHERE EXISTS (
     SELECT 1 FROM project_release_jobs
      WHERE github_repository_id = NEW.github_repository_id
        AND organization_id = NEW.organization_id
   );

  INSERT OR IGNORE INTO project_release_evidence_scopes
    (github_repository_id, prefix)
  SELECT github_repository_id, 'project/' || project_id || '/'
    FROM project_release_jobs
   WHERE github_repository_id = NEW.github_repository_id
     AND organization_id = NEW.organization_id;

  UPDATE project_release_jobs SET evidence_scopes_seeded = 1
   WHERE github_repository_id = NEW.github_repository_id;

  INSERT OR IGNORE INTO project_release_requests
    (github_repository_id, project_id, organization_id, github_name, default_branch, requested_at)
  SELECT github_repository_id, project_id, organization_id, github_name, default_branch, started_at
    FROM project_release_jobs
   WHERE github_repository_id = NEW.github_repository_id;
END;

ALTER TABLE organizations ADD COLUMN repository_selection TEXT
  CHECK (repository_selection IN ('all', 'selected'));

-- A project id is its incarnation. Queue authority carries it so a writer that
-- loaded the old project cannot save into a newly selected project that happens
-- to have the same GitHub repository id.
ALTER TABLE queue_state ADD COLUMN project_id TEXT;

ALTER TABLE queue_projects ADD COLUMN project_id TEXT;
-- Existing repositories keep protocol 1 until a reviewed workflow-upgrade PR
-- merges. New enrolments write 2 explicitly. The default keeps the old Worker
-- compatible while both generations may still insert queue rows.
ALTER TABLE queue_projects ADD COLUMN verifier_workflow_version INTEGER NOT NULL DEFAULT 1
  CHECK (verifier_workflow_version IN (1, 2));

-- Every repository-keyed write carries the project incarnation. These columns
-- stay nullable during the old-Worker drain because the previous Worker cannot
-- supply them; compatibility triggers fill its ordinary writes. Migration
-- 0031 removes those triggers and rejects any new row that does not name the
-- exact current project.
ALTER TABLE queue_status_comments ADD COLUMN project_id TEXT;
ALTER TABLE queue_runners ADD COLUMN project_id TEXT;
ALTER TABLE queue_assignments ADD COLUMN project_id TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN project_id TEXT;
-- Protocol 1 dispatches created before this migration have no attempt id. They
-- remain representable and are accepted only while the current queue attempt
-- and exact project-bound dispatch agree. Every new dispatch records both.
ALTER TABLE candidate_dispatches ADD COLUMN attempt_id TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN workflow_protocol INTEGER NOT NULL DEFAULT 1
  CHECK (workflow_protocol IN (1, 2));
ALTER TABLE candidate_verdicts ADD COLUMN project_id TEXT;
ALTER TABLE queue_attestations ADD COLUMN project_id TEXT;
ALTER TABLE queue_transitions_index ADD COLUMN project_id TEXT;
ALTER TABLE queue_entries_index ADD COLUMN project_id TEXT;
ALTER TABLE queue_projection_marks ADD COLUMN project_id TEXT;

-- Existing rows are backfilled by the lifecycle-aware Worker in bounded
-- rowid pages. Migration 0031 is refused until every table reports zero NULL
-- project ids and remains below the reviewed rebuild ceiling.
CREATE TABLE IF NOT EXISTS project_lifecycle_backfills (
  table_name TEXT PRIMARY KEY,
  completed_at TEXT,
  verified_row_count INTEGER,
  CHECK (verified_row_count IS NULL OR verified_row_count >= 0)
);
INSERT OR IGNORE INTO project_lifecycle_backfills (table_name) VALUES
  ('queue_state'), ('queue_projects'), ('queue_status_comments'),
  ('queue_runners'), ('queue_assignments'), ('candidate_dispatches'),
  ('candidate_verdicts'), ('queue_attestations'),
  ('queue_transitions_index'), ('queue_entries_index'),
  ('queue_projection_marks');

-- Keep the migration compatible with the old Worker until 0031 applies after
-- the new Worker is live. Old inserts omit project_id; these triggers fill it.
CREATE TRIGGER queue_state_backfills_project
AFTER INSERT ON queue_state WHEN NEW.project_id IS NULL
BEGIN
  UPDATE queue_state
     SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
   WHERE github_repository_id = NEW.github_repository_id AND base_ref = NEW.base_ref;
END;

CREATE TRIGGER queue_projects_backfills_project
AFTER INSERT ON queue_projects WHEN NEW.project_id IS NULL
BEGIN
  UPDATE queue_projects
     SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
   WHERE id = NEW.id;
END;

CREATE TRIGGER queue_status_comments_backfills_project AFTER INSERT ON queue_status_comments WHEN NEW.project_id IS NULL BEGIN
  UPDATE queue_status_comments SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
   WHERE github_repository_id = NEW.github_repository_id AND base_ref = NEW.base_ref AND pull_request_number = NEW.pull_request_number;
END;
CREATE TRIGGER queue_runners_backfills_project AFTER INSERT ON queue_runners WHEN NEW.project_id IS NULL BEGIN
  UPDATE queue_runners SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
   WHERE github_repository_id = NEW.github_repository_id AND principal_id = NEW.principal_id AND device_key_id = NEW.device_key_id;
END;
CREATE TRIGGER queue_assignments_backfills_project AFTER INSERT ON queue_assignments WHEN NEW.project_id IS NULL BEGIN
  UPDATE queue_assignments SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = NEW.github_repository_id) WHERE assignment_id = NEW.assignment_id;
END;
CREATE TRIGGER candidate_dispatches_backfills_project AFTER INSERT ON candidate_dispatches WHEN NEW.project_id IS NULL BEGIN
  UPDATE candidate_dispatches SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
   WHERE github_repository_id = NEW.github_repository_id AND base_ref = NEW.base_ref AND candidate_tree_oid = NEW.candidate_tree_oid;
END;
CREATE TRIGGER candidate_verdicts_backfills_project AFTER INSERT ON candidate_verdicts WHEN NEW.project_id IS NULL BEGIN
  UPDATE candidate_verdicts SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
   WHERE github_repository_id = NEW.github_repository_id AND base_ref = NEW.base_ref AND candidate_tree_oid = NEW.candidate_tree_oid;
END;
CREATE TRIGGER queue_attestations_backfills_project AFTER INSERT ON queue_attestations WHEN NEW.project_id IS NULL BEGIN
  UPDATE queue_attestations SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = NEW.github_repository_id) WHERE digest = NEW.digest;
END;
CREATE TRIGGER queue_transitions_index_backfills_project AFTER INSERT ON queue_transitions_index WHEN NEW.project_id IS NULL BEGIN
  UPDATE queue_transitions_index SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = NEW.github_repository_id) WHERE id = NEW.id;
END;
CREATE TRIGGER queue_entries_index_backfills_project AFTER INSERT ON queue_entries_index WHEN NEW.project_id IS NULL BEGIN
  UPDATE queue_entries_index SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = NEW.github_repository_id) WHERE id = NEW.id;
END;
CREATE TRIGGER queue_projection_marks_backfills_project AFTER INSERT ON queue_projection_marks WHEN NEW.project_id IS NULL BEGIN
  UPDATE queue_projection_marks SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
   WHERE github_repository_id = NEW.github_repository_id AND base_ref = NEW.base_ref;
END;

CREATE TABLE IF NOT EXISTS project_write_leases (
  github_repository_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, owner_token)
);

CREATE INDEX IF NOT EXISTS project_write_leases_expiry
  ON project_write_leases (github_repository_id, expires_at);

-- Rollout state is operational evidence, not repository history. Cleanup is
-- disabled until an operator has retired the old Worker's D1 database, R2
-- bucket, and GitHub App private key, then the finishing migration has installed the
-- incarnation-bound schema. Time elapsed after a deploy is not a capability
-- boundary: an HTTP invocation may remain alive while its client is connected.
CREATE TABLE IF NOT EXISTS project_lifecycle_rollout (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  maintenance_mode INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_mode IN (0, 1)),
  worker_activated_at TEXT,
  remote_capabilities_retired_at TEXT,
  remote_capability_evidence TEXT,
  destructive_schema_ready_at TEXT,
  CHECK (
    (remote_capabilities_retired_at IS NULL AND remote_capability_evidence IS NULL)
    OR (remote_capabilities_retired_at IS NOT NULL AND length(remote_capability_evidence) > 0)
  )
);
INSERT OR IGNORE INTO project_lifecycle_rollout
  (id, maintenance_mode, worker_activated_at, remote_capabilities_retired_at, remote_capability_evidence, destructive_schema_ready_at)
VALUES (1, 0, NULL, NULL, NULL, NULL);

-- Serialise authoritative reads of one installation. Webhook deliveries are
-- hints and can arrive in any order; the holder always re-reads GitHub. A lease
-- disappears after a successful sync and can be taken over after a crashed
-- Worker has been absent for ten minutes.
CREATE TABLE IF NOT EXISTS installation_sync_leases (
  installation_id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- The old Worker remains live between this migration and the new deployment.
-- It does not acquire lifecycle leases, so these guards stop its delayed inserts
-- once the new Worker has requested a release. A current new-Worker lease may
-- finish recording an operation that already reached GitHub; the release job
-- still blocks every writer once all such leases have drained.
CREATE TRIGGER project_release_guards_projects
BEFORE INSERT ON projects WHEN
  EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
  OR EXISTS (
    SELECT 1 FROM project_legacy_cleanup_scopes s
     WHERE s.github_repository_id = NEW.github_repository_id
       AND s.organization_id = NEW.organization_id
  )
BEGIN SELECT RAISE(ABORT, 'repository release is still in progress'); END;

-- This legacy telemetry table had no project foreign key. Remove any orphan
-- left by a pre-migration removal, then stop the old Worker from inserting a
-- new one after a lifecycle request has been made.
DELETE FROM verification_observations
 WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = verification_observations.project_id);
CREATE TRIGGER project_release_guards_verification_observations
BEFORE INSERT ON verification_observations WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = NEW.project_id)
  OR EXISTS (
    SELECT 1 FROM projects p JOIN project_release_requests r
      ON r.github_repository_id = p.github_repository_id
     WHERE p.id = NEW.project_id
  )
  OR EXISTS (
    SELECT 1 FROM projects p JOIN project_release_jobs j
      ON j.github_repository_id = p.github_repository_id
     WHERE p.id = NEW.project_id
  )
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_team_repos
BEFORE INSERT ON team_repos WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.organization_id = NEW.organization_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_queue_status_comments
BEFORE INSERT ON queue_status_comments WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_queue_runners
BEFORE INSERT ON queue_runners WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_queue_assignments
BEFORE INSERT ON queue_assignments WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_candidate_dispatches
BEFORE INSERT ON candidate_dispatches WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_candidate_verdicts
BEFORE INSERT ON candidate_verdicts WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_queue_attestations
BEFORE INSERT ON queue_attestations WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_queue_transitions_index
BEFORE INSERT ON queue_transitions_index WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_queue_entries_index
BEFORE INSERT ON queue_entries_index WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_queue_projection_marks
BEFORE INSERT ON queue_projection_marks WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_queue_state
BEFORE INSERT ON queue_state WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_release_guards_queue_projects
BEFORE INSERT ON queue_projects WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;


-- A D1 export is coherent only after every old Worker invocation has lost the
-- ability to mutate the source database. These database-level triggers also
-- stop invocations that started before the lifecycle-aware Worker deployed.
-- The rollout row itself remains writable so an operator can enter maintenance
-- and record cutover evidence. Migration 0031 runs only against the new,
-- unexposed D1 generation and removes these temporary source-database guards.
CREATE TRIGGER project_lifecycle_maintenance_account_insert
BEFORE INSERT ON "account" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_account_update
BEFORE UPDATE ON "account" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_account_delete
BEFORE DELETE ON "account" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_candidate_dispatches_insert
BEFORE INSERT ON "candidate_dispatches" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_candidate_dispatches_update
BEFORE UPDATE ON "candidate_dispatches" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_candidate_dispatches_delete
BEFORE DELETE ON "candidate_dispatches" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_candidate_verdicts_insert
BEFORE INSERT ON "candidate_verdicts" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_candidate_verdicts_update
BEFORE UPDATE ON "candidate_verdicts" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_candidate_verdicts_delete
BEFORE DELETE ON "candidate_verdicts" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_deviceCode_insert
BEFORE INSERT ON "deviceCode" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_deviceCode_update
BEFORE UPDATE ON "deviceCode" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_deviceCode_delete
BEFORE DELETE ON "deviceCode" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_device_keys_insert
BEFORE INSERT ON "device_keys" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_device_keys_update
BEFORE UPDATE ON "device_keys" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_device_keys_delete
BEFORE DELETE ON "device_keys" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_enroll_challenges_insert
BEFORE INSERT ON "enroll_challenges" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_enroll_challenges_update
BEFORE UPDATE ON "enroll_challenges" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_enroll_challenges_delete
BEFORE DELETE ON "enroll_challenges" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_grants_insert
BEFORE INSERT ON "github_sync_grants" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_grants_update
BEFORE UPDATE ON "github_sync_grants" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_grants_delete
BEFORE DELETE ON "github_sync_grants" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_people_insert
BEFORE INSERT ON "github_sync_people" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_people_update
BEFORE UPDATE ON "github_sync_people" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_people_delete
BEFORE DELETE ON "github_sync_people" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_snapshots_insert
BEFORE INSERT ON "github_sync_snapshots" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_snapshots_update
BEFORE UPDATE ON "github_sync_snapshots" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_snapshots_delete
BEFORE DELETE ON "github_sync_snapshots" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_repositories_insert
BEFORE INSERT ON github_sync_repositories WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;
CREATE TRIGGER project_lifecycle_maintenance_github_sync_repositories_update
BEFORE UPDATE ON github_sync_repositories WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;
CREATE TRIGGER project_lifecycle_maintenance_github_sync_repositories_delete
BEFORE DELETE ON github_sync_repositories WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_repository_authority_insert
BEFORE INSERT ON github_repository_authority WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;
CREATE TRIGGER project_lifecycle_maintenance_github_repository_authority_update
BEFORE UPDATE ON github_repository_authority WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;
CREATE TRIGGER project_lifecycle_maintenance_github_repository_authority_delete
BEFORE DELETE ON github_repository_authority WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_repository_reconcile_leases_insert
BEFORE INSERT ON github_repository_reconcile_leases WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;
CREATE TRIGGER project_lifecycle_maintenance_github_repository_reconcile_leases_update
BEFORE UPDATE ON github_repository_reconcile_leases WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;
CREATE TRIGGER project_lifecycle_maintenance_github_repository_reconcile_leases_delete
BEFORE DELETE ON github_repository_reconcile_leases WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_reimport_quarantines_insert
BEFORE INSERT ON project_reimport_quarantines WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;
CREATE TRIGGER project_lifecycle_maintenance_project_reimport_quarantines_update
BEFORE UPDATE ON project_reimport_quarantines WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;
CREATE TRIGGER project_lifecycle_maintenance_project_reimport_quarantines_delete
BEFORE DELETE ON project_reimport_quarantines WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_lifecycle_backfills_insert
BEFORE INSERT ON project_lifecycle_backfills WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;
CREATE TRIGGER project_lifecycle_maintenance_project_lifecycle_backfills_update
BEFORE UPDATE ON project_lifecycle_backfills WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;
CREATE TRIGGER project_lifecycle_maintenance_project_lifecycle_backfills_delete
BEFORE DELETE ON project_lifecycle_backfills WHEN (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_team_members_insert
BEFORE INSERT ON "github_sync_team_members" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_team_members_update
BEFORE UPDATE ON "github_sync_team_members" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_team_members_delete
BEFORE DELETE ON "github_sync_team_members" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_team_repos_insert
BEFORE INSERT ON "github_sync_team_repos" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_team_repos_update
BEFORE UPDATE ON "github_sync_team_repos" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_team_repos_delete
BEFORE DELETE ON "github_sync_team_repos" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_teams_insert
BEFORE INSERT ON "github_sync_teams" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_teams_update
BEFORE UPDATE ON "github_sync_teams" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_sync_teams_delete
BEFORE DELETE ON "github_sync_teams" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_teams_insert
BEFORE INSERT ON "github_teams" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_teams_update
BEFORE UPDATE ON "github_teams" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_github_teams_delete
BEFORE DELETE ON "github_teams" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_installation_sync_leases_insert
BEFORE INSERT ON "installation_sync_leases" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_installation_sync_leases_update
BEFORE UPDATE ON "installation_sync_leases" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_installation_sync_leases_delete
BEFORE DELETE ON "installation_sync_leases" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_invitation_insert
BEFORE INSERT ON "invitation" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_invitation_update
BEFORE UPDATE ON "invitation" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_invitation_delete
BEFORE DELETE ON "invitation" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_member_insert
BEFORE INSERT ON "member" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_member_update
BEFORE UPDATE ON "member" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_member_delete
BEFORE DELETE ON "member" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_organization_insert
BEFORE INSERT ON "organization" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_organization_update
BEFORE UPDATE ON "organization" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_organization_delete
BEFORE DELETE ON "organization" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_organizations_insert
BEFORE INSERT ON "organizations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_organizations_update
BEFORE UPDATE ON "organizations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_organizations_delete
BEFORE DELETE ON "organizations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_policy_bundles_insert
BEFORE INSERT ON "policy_bundles" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_policy_bundles_update
BEFORE UPDATE ON "policy_bundles" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_policy_bundles_delete
BEFORE DELETE ON "policy_bundles" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_principals_insert
BEFORE INSERT ON "principals" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_principals_update
BEFORE UPDATE ON "principals" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_principals_delete
BEFORE DELETE ON "principals" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_deletion_audits_insert
BEFORE INSERT ON "project_deletion_audits" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_deletion_audits_update
BEFORE UPDATE ON "project_deletion_audits" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_deletion_audits_delete
BEFORE DELETE ON "project_deletion_audits" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_legacy_cleanup_scopes_insert
BEFORE INSERT ON "project_legacy_cleanup_scopes" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_legacy_cleanup_scopes_update
BEFORE UPDATE ON "project_legacy_cleanup_scopes" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_legacy_cleanup_scopes_delete
BEFORE DELETE ON "project_legacy_cleanup_scopes" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_r2_cleanup_intents_insert
BEFORE INSERT ON "project_r2_cleanup_intents" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_r2_cleanup_intents_update
BEFORE UPDATE ON "project_r2_cleanup_intents" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_r2_cleanup_intents_delete
BEFORE DELETE ON "project_r2_cleanup_intents" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_r2_capability_generations_insert
BEFORE INSERT ON "project_r2_capability_generations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_r2_capability_generations_update
BEFORE UPDATE ON "project_r2_capability_generations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_r2_capability_generations_delete
BEFORE DELETE ON "project_r2_capability_generations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_evidence_scopes_insert
BEFORE INSERT ON "project_release_evidence_scopes" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_evidence_scopes_update
BEFORE UPDATE ON "project_release_evidence_scopes" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_evidence_scopes_delete
BEFORE DELETE ON "project_release_evidence_scopes" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_jobs_insert
BEFORE INSERT ON "project_release_jobs" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_jobs_update
BEFORE UPDATE ON "project_release_jobs" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_jobs_delete
BEFORE DELETE ON "project_release_jobs" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_queue_refs_insert
BEFORE INSERT ON "project_release_queue_refs" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_queue_refs_update
BEFORE UPDATE ON "project_release_queue_refs" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_queue_refs_delete
BEFORE DELETE ON "project_release_queue_refs" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_requests_insert
BEFORE INSERT ON "project_release_requests" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_requests_update
BEFORE UPDATE ON "project_release_requests" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_release_requests_delete
BEFORE DELETE ON "project_release_requests" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_write_leases_insert
BEFORE INSERT ON "project_write_leases" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_write_leases_update
BEFORE UPDATE ON "project_write_leases" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_project_write_leases_delete
BEFORE DELETE ON "project_write_leases" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_projects_insert
BEFORE INSERT ON "projects" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_projects_update
BEFORE UPDATE ON "projects" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_projects_delete
BEFORE DELETE ON "projects" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_proof_verifications_insert
BEFORE INSERT ON "proof_verifications" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_proof_verifications_update
BEFORE UPDATE ON "proof_verifications" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_proof_verifications_delete
BEFORE DELETE ON "proof_verifications" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_assignments_insert
BEFORE INSERT ON "queue_assignments" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_assignments_update
BEFORE UPDATE ON "queue_assignments" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_assignments_delete
BEFORE DELETE ON "queue_assignments" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_attestations_insert
BEFORE INSERT ON "queue_attestations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_attestations_update
BEFORE UPDATE ON "queue_attestations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_attestations_delete
BEFORE DELETE ON "queue_attestations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_clock_insert
BEFORE INSERT ON "queue_clock" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_clock_update
BEFORE UPDATE ON "queue_clock" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_clock_delete
BEFORE DELETE ON "queue_clock" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_entries_index_insert
BEFORE INSERT ON "queue_entries_index" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_entries_index_update
BEFORE UPDATE ON "queue_entries_index" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_entries_index_delete
BEFORE DELETE ON "queue_entries_index" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_projection_marks_insert
BEFORE INSERT ON "queue_projection_marks" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_projection_marks_update
BEFORE UPDATE ON "queue_projection_marks" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_projection_marks_delete
BEFORE DELETE ON "queue_projection_marks" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_projects_insert
BEFORE INSERT ON "queue_projects" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_projects_update
BEFORE UPDATE ON "queue_projects" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_projects_delete
BEFORE DELETE ON "queue_projects" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_runners_insert
BEFORE INSERT ON "queue_runners" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_runners_update
BEFORE UPDATE ON "queue_runners" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_runners_delete
BEFORE DELETE ON "queue_runners" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_state_insert
BEFORE INSERT ON "queue_state" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_state_update
BEFORE UPDATE ON "queue_state" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_state_delete
BEFORE DELETE ON "queue_state" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_status_comments_insert
BEFORE INSERT ON "queue_status_comments" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_status_comments_update
BEFORE UPDATE ON "queue_status_comments" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_status_comments_delete
BEFORE DELETE ON "queue_status_comments" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_transitions_index_insert
BEFORE INSERT ON "queue_transitions_index" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_transitions_index_update
BEFORE UPDATE ON "queue_transitions_index" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_queue_transitions_index_delete
BEFORE DELETE ON "queue_transitions_index" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_removed_projects_insert
BEFORE INSERT ON "removed_projects" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_removed_projects_update
BEFORE UPDATE ON "removed_projects" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_removed_projects_delete
BEFORE DELETE ON "removed_projects" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_repository_grants_insert
BEFORE INSERT ON "repository_grants" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_repository_grants_update
BEFORE UPDATE ON "repository_grants" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_repository_grants_delete
BEFORE DELETE ON "repository_grants" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_service_keys_insert
BEFORE INSERT ON "service_keys" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_service_keys_update
BEFORE UPDATE ON "service_keys" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_service_keys_delete
BEFORE DELETE ON "service_keys" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_session_insert
BEFORE INSERT ON "session" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_session_update
BEFORE UPDATE ON "session" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_session_delete
BEFORE DELETE ON "session" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_stripe_events_insert
BEFORE INSERT ON "stripe_events" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_stripe_events_update
BEFORE UPDATE ON "stripe_events" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_stripe_events_delete
BEFORE DELETE ON "stripe_events" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_stripe_state_insert
BEFORE INSERT ON "stripe_state" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_stripe_state_update
BEFORE UPDATE ON "stripe_state" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_stripe_state_delete
BEFORE DELETE ON "stripe_state" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_subscription_insert
BEFORE INSERT ON "subscription" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_subscription_update
BEFORE UPDATE ON "subscription" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_subscription_delete
BEFORE DELETE ON "subscription" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_team_members_insert
BEFORE INSERT ON "team_members" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_team_members_update
BEFORE UPDATE ON "team_members" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_team_members_delete
BEFORE DELETE ON "team_members" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_team_repos_insert
BEFORE INSERT ON "team_repos" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_team_repos_update
BEFORE UPDATE ON "team_repos" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_team_repos_delete
BEFORE DELETE ON "team_repos" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_user_insert
BEFORE INSERT ON "user" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_user_update
BEFORE UPDATE ON "user" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_user_delete
BEFORE DELETE ON "user" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_verification_insert
BEFORE INSERT ON "verification" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_verification_update
BEFORE UPDATE ON "verification" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_verification_delete
BEFORE DELETE ON "verification" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_verification_observations_insert
BEFORE INSERT ON "verification_observations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_verification_observations_update
BEFORE UPDATE ON "verification_observations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_verification_observations_delete
BEFORE DELETE ON "verification_observations" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_webhook_deliveries_insert
BEFORE INSERT ON "webhook_deliveries" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_webhook_deliveries_update
BEFORE UPDATE ON "webhook_deliveries" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;

CREATE TRIGGER project_lifecycle_maintenance_webhook_deliveries_delete
BEFORE DELETE ON "webhook_deliveries" WHEN
  (SELECT maintenance_mode FROM project_lifecycle_rollout WHERE id = 1) = 1
BEGIN SELECT RAISE(ABORT, 'project lifecycle maintenance is active'); END;
