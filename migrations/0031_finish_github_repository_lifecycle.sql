-- DEPLOY ORDER: after-worker
-- The 0030 migration is additive so the previous Worker remains healthy while
-- this release deploys. Once the lifecycle-aware Worker is live, make project
-- incarnation ownership mandatory and remove the superseded tombstone schema.
-- The migration runner exposes this file only after the exact Worker has served
-- for one compatibility window and the bounded project-id backfill is complete.

-- This migration runs in place. It enters maintenance in the same transaction
-- before rebuilding tables. No D1 export/import, R2 bucket replacement, or
-- GitHub App key rotation is part of the repository lifecycle.
-- The backfill ledger is the one table this migration must update while the
-- database is fenced. Keep every application table guarded, but let
-- this migration record and verify the completed backfill.
CREATE TABLE project_lifecycle_cutover_guard (ready INTEGER NOT NULL CHECK (ready = 1));
INSERT INTO project_lifecycle_cutover_guard
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM project_lifecycle_rollout
   WHERE id = 1
     AND maintenance_mode = 0
     AND worker_activated_at IS NOT NULL
     AND unixepoch(worker_activated_at) IS NOT NULL
     AND unixepoch(worker_activated_at) <= unixepoch('now') - 3600
     AND destructive_schema_ready_at IS NULL
) THEN 1 ELSE 0 END;
DROP TABLE project_lifecycle_cutover_guard;

-- D1 applies this file atomically. Once it commits, every Worker entry point
-- sees maintenance mode before it can use the rebuilt schema. A failure rolls
-- this update back together with every schema change.
UPDATE project_lifecycle_rollout
   SET maintenance_mode = 1
 WHERE id = 1 AND maintenance_mode = 0;

DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_lifecycle_backfills_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_lifecycle_backfills_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_lifecycle_backfills_delete;

UPDATE project_lifecycle_backfills SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  verified_row_count = (SELECT count(*) FROM queue_state)
 WHERE table_name = 'queue_state' AND NOT EXISTS (SELECT 1 FROM queue_state WHERE project_id IS NULL)
   AND (SELECT count(*) FROM queue_state) <= 25000;
UPDATE project_lifecycle_backfills SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  verified_row_count = (SELECT count(*) FROM queue_projects)
 WHERE table_name = 'queue_projects' AND NOT EXISTS (SELECT 1 FROM queue_projects WHERE project_id IS NULL)
   AND (SELECT count(*) FROM queue_projects) <= 25000;
UPDATE project_lifecycle_backfills SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  verified_row_count = (SELECT count(*) FROM queue_status_comments)
 WHERE table_name = 'queue_status_comments' AND NOT EXISTS (SELECT 1 FROM queue_status_comments WHERE project_id IS NULL)
   AND (SELECT count(*) FROM queue_status_comments) <= 25000;
UPDATE project_lifecycle_backfills SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  verified_row_count = (SELECT count(*) FROM queue_runners)
 WHERE table_name = 'queue_runners' AND NOT EXISTS (SELECT 1 FROM queue_runners WHERE project_id IS NULL)
   AND (SELECT count(*) FROM queue_runners) <= 25000;
UPDATE project_lifecycle_backfills SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  verified_row_count = (SELECT count(*) FROM queue_assignments)
 WHERE table_name = 'queue_assignments' AND NOT EXISTS (SELECT 1 FROM queue_assignments WHERE project_id IS NULL)
   AND (SELECT count(*) FROM queue_assignments) <= 25000;
UPDATE project_lifecycle_backfills SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  verified_row_count = (SELECT count(*) FROM candidate_dispatches)
 WHERE table_name = 'candidate_dispatches' AND NOT EXISTS (SELECT 1 FROM candidate_dispatches WHERE project_id IS NULL)
   AND (SELECT count(*) FROM candidate_dispatches) <= 25000;
UPDATE project_lifecycle_backfills SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  verified_row_count = (SELECT count(*) FROM candidate_verdicts)
 WHERE table_name = 'candidate_verdicts' AND NOT EXISTS (SELECT 1 FROM candidate_verdicts WHERE project_id IS NULL)
   AND (SELECT count(*) FROM candidate_verdicts) <= 25000;
UPDATE project_lifecycle_backfills SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  verified_row_count = (SELECT count(*) FROM queue_attestations)
 WHERE table_name = 'queue_attestations' AND NOT EXISTS (SELECT 1 FROM queue_attestations WHERE project_id IS NULL)
   AND (SELECT count(*) FROM queue_attestations) <= 25000;
UPDATE project_lifecycle_backfills SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  verified_row_count = (SELECT count(*) FROM queue_transitions_index)
 WHERE table_name = 'queue_transitions_index' AND NOT EXISTS (SELECT 1 FROM queue_transitions_index WHERE project_id IS NULL)
   AND (SELECT count(*) FROM queue_transitions_index) <= 25000;
UPDATE project_lifecycle_backfills SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  verified_row_count = (SELECT count(*) FROM queue_entries_index)
 WHERE table_name = 'queue_entries_index' AND NOT EXISTS (SELECT 1 FROM queue_entries_index WHERE project_id IS NULL)
   AND (SELECT count(*) FROM queue_entries_index) <= 25000;
UPDATE project_lifecycle_backfills SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  verified_row_count = (SELECT count(*) FROM queue_projection_marks)
 WHERE table_name = 'queue_projection_marks' AND NOT EXISTS (SELECT 1 FROM queue_projection_marks WHERE project_id IS NULL)
   AND (SELECT count(*) FROM queue_projection_marks) <= 25000;

CREATE TABLE project_lifecycle_backfill_guard (ready INTEGER NOT NULL CHECK (ready = 1));
INSERT INTO project_lifecycle_backfill_guard
SELECT CASE WHEN
  (SELECT count(*) FROM project_lifecycle_backfills) = 11
  AND (SELECT completed_at IS NOT NULL AND verified_row_count = (SELECT count(*) FROM queue_state)
         FROM project_lifecycle_backfills WHERE table_name = 'queue_state')
  AND (SELECT count(*) FROM queue_state) <= 25000
  AND NOT EXISTS (SELECT 1 FROM queue_state WHERE project_id IS NULL)
  AND (SELECT completed_at IS NOT NULL AND verified_row_count = (SELECT count(*) FROM queue_projects)
         FROM project_lifecycle_backfills WHERE table_name = 'queue_projects')
  AND (SELECT count(*) FROM queue_projects) <= 25000
  AND NOT EXISTS (SELECT 1 FROM queue_projects WHERE project_id IS NULL)
  AND (SELECT completed_at IS NOT NULL AND verified_row_count = (SELECT count(*) FROM queue_status_comments)
         FROM project_lifecycle_backfills WHERE table_name = 'queue_status_comments')
  AND (SELECT count(*) FROM queue_status_comments) <= 25000
  AND NOT EXISTS (SELECT 1 FROM queue_status_comments WHERE project_id IS NULL)
  AND (SELECT completed_at IS NOT NULL AND verified_row_count = (SELECT count(*) FROM queue_runners)
         FROM project_lifecycle_backfills WHERE table_name = 'queue_runners')
  AND (SELECT count(*) FROM queue_runners) <= 25000
  AND NOT EXISTS (SELECT 1 FROM queue_runners WHERE project_id IS NULL)
  AND (SELECT completed_at IS NOT NULL AND verified_row_count = (SELECT count(*) FROM queue_assignments)
         FROM project_lifecycle_backfills WHERE table_name = 'queue_assignments')
  AND (SELECT count(*) FROM queue_assignments) <= 25000
  AND NOT EXISTS (SELECT 1 FROM queue_assignments WHERE project_id IS NULL)
  AND (SELECT completed_at IS NOT NULL AND verified_row_count = (SELECT count(*) FROM candidate_dispatches)
         FROM project_lifecycle_backfills WHERE table_name = 'candidate_dispatches')
  AND (SELECT count(*) FROM candidate_dispatches) <= 25000
  AND NOT EXISTS (SELECT 1 FROM candidate_dispatches WHERE project_id IS NULL)
  AND (SELECT completed_at IS NOT NULL AND verified_row_count = (SELECT count(*) FROM candidate_verdicts)
         FROM project_lifecycle_backfills WHERE table_name = 'candidate_verdicts')
  AND (SELECT count(*) FROM candidate_verdicts) <= 25000
  AND NOT EXISTS (SELECT 1 FROM candidate_verdicts WHERE project_id IS NULL)
  AND (SELECT completed_at IS NOT NULL AND verified_row_count = (SELECT count(*) FROM queue_attestations)
         FROM project_lifecycle_backfills WHERE table_name = 'queue_attestations')
  AND (SELECT count(*) FROM queue_attestations) <= 25000
  AND NOT EXISTS (SELECT 1 FROM queue_attestations WHERE project_id IS NULL)
  AND (SELECT completed_at IS NOT NULL AND verified_row_count = (SELECT count(*) FROM queue_transitions_index)
         FROM project_lifecycle_backfills WHERE table_name = 'queue_transitions_index')
  AND (SELECT count(*) FROM queue_transitions_index) <= 25000
  AND NOT EXISTS (SELECT 1 FROM queue_transitions_index WHERE project_id IS NULL)
  AND (SELECT completed_at IS NOT NULL AND verified_row_count = (SELECT count(*) FROM queue_entries_index)
         FROM project_lifecycle_backfills WHERE table_name = 'queue_entries_index')
  AND (SELECT count(*) FROM queue_entries_index) <= 25000
  AND NOT EXISTS (SELECT 1 FROM queue_entries_index WHERE project_id IS NULL)
  AND (SELECT completed_at IS NOT NULL AND verified_row_count = (SELECT count(*) FROM queue_projection_marks)
         FROM project_lifecycle_backfills WHERE table_name = 'queue_projection_marks')
  AND (SELECT count(*) FROM queue_projection_marks) <= 25000
  AND NOT EXISTS (SELECT 1 FROM queue_projection_marks WHERE project_id IS NULL)
THEN 1 ELSE 0 END;
DROP TABLE project_lifecycle_backfill_guard;

DROP TRIGGER IF EXISTS project_lifecycle_maintenance_account_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_account_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_account_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_candidate_dispatches_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_candidate_dispatches_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_candidate_dispatches_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_candidate_verdicts_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_candidate_verdicts_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_candidate_verdicts_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_deviceCode_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_deviceCode_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_deviceCode_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_device_keys_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_device_keys_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_device_keys_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_enroll_challenges_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_enroll_challenges_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_enroll_challenges_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_grants_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_grants_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_grants_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_people_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_people_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_people_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_snapshots_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_snapshots_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_snapshots_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_team_members_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_team_members_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_team_members_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_team_repos_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_team_repos_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_team_repos_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_teams_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_teams_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_teams_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_teams_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_teams_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_teams_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_installation_sync_leases_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_installation_sync_leases_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_installation_sync_leases_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_invitation_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_invitation_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_invitation_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_member_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_member_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_member_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_organization_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_organization_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_organization_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_organizations_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_organizations_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_organizations_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_policy_bundles_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_policy_bundles_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_policy_bundles_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_principals_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_principals_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_principals_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_deletion_audits_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_deletion_audits_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_deletion_audits_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_legacy_cleanup_scopes_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_legacy_cleanup_scopes_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_legacy_cleanup_scopes_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_evidence_scopes_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_evidence_scopes_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_evidence_scopes_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_jobs_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_jobs_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_jobs_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_queue_refs_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_queue_refs_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_queue_refs_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_requests_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_requests_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_release_requests_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_r2_cleanup_intents_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_r2_cleanup_intents_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_r2_cleanup_intents_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_r2_capability_generations_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_r2_capability_generations_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_r2_capability_generations_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_write_leases_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_write_leases_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_write_leases_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_projects_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_projects_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_projects_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_proof_verifications_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_proof_verifications_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_proof_verifications_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_assignments_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_assignments_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_assignments_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_attestations_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_attestations_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_attestations_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_clock_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_clock_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_clock_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_entries_index_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_entries_index_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_entries_index_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_projection_marks_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_projection_marks_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_projection_marks_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_projects_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_projects_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_projects_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_runners_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_runners_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_runners_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_state_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_state_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_state_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_status_comments_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_status_comments_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_status_comments_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_transitions_index_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_transitions_index_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_queue_transitions_index_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_removed_projects_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_removed_projects_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_removed_projects_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_repository_grants_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_repository_grants_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_repository_grants_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_service_keys_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_service_keys_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_service_keys_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_session_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_session_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_session_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_stripe_events_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_stripe_events_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_stripe_events_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_stripe_state_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_stripe_state_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_stripe_state_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_subscription_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_subscription_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_subscription_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_team_members_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_team_members_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_team_members_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_team_repos_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_team_repos_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_team_repos_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_user_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_user_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_user_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_verification_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_verification_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_verification_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_verification_observations_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_verification_observations_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_verification_observations_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_webhook_deliveries_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_webhook_deliveries_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_webhook_deliveries_delete;


-- The previous Worker can create a tombstone after 0030 and before this
-- after-worker migration. Convert that last window again immediately before
-- dropping the legacy tables, and keep every tenant R2 prefix.
INSERT OR IGNORE INTO project_release_jobs
  (github_repository_id, project_id, organization_id, github_name, default_branch, started_at)
SELECT p.github_repository_id, p.id, p.organization_id, p.github_name,
       p.default_branch, MIN(r.deleted_at)
  FROM projects p JOIN removed_projects r
    ON r.github_repository_id = p.github_repository_id
   AND r.organization_id = p.organization_id
 GROUP BY p.github_repository_id, p.id, p.organization_id, p.github_name, p.default_branch;

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

DROP TRIGGER IF EXISTS project_release_captures_late_tombstone;

DROP TRIGGER IF EXISTS project_release_guards_team_repos;
DROP TRIGGER IF EXISTS project_release_guards_queue_status_comments;
DROP TRIGGER IF EXISTS project_release_guards_queue_runners;
DROP TRIGGER IF EXISTS project_release_guards_queue_assignments;
DROP TRIGGER IF EXISTS project_release_guards_candidate_dispatches;
DROP TRIGGER IF EXISTS project_release_guards_candidate_verdicts;
DROP TRIGGER IF EXISTS project_release_guards_queue_attestations;
DROP TRIGGER IF EXISTS project_release_guards_queue_transitions_index;
DROP TRIGGER IF EXISTS project_release_guards_queue_entries_index;
DROP TRIGGER IF EXISTS project_release_guards_queue_projection_marks;
DROP TRIGGER IF EXISTS project_release_guards_queue_state;
DROP TRIGGER IF EXISTS project_release_guards_queue_projects;
DROP TRIGGER IF EXISTS project_release_guards_verification_observations;

-- Keep the project guard under its final name. Re-import happens only after
-- the transient request and job are gone, so normal authoritative sync is
-- unaffected while delayed old restore requests remain fail-closed.
DROP TRIGGER IF EXISTS project_release_guards_projects;
CREATE TRIGGER project_membership_guards_projects
BEFORE INSERT ON projects WHEN
  EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
  OR EXISTS (
    SELECT 1 FROM project_legacy_cleanup_scopes s
     WHERE s.github_repository_id = NEW.github_repository_id
       AND s.organization_id = NEW.organization_id
  )
BEGIN SELECT RAISE(ABORT, 'repository release is still in progress'); END;

-- Give the telemetry table the project ownership constraint it originally
-- lacked. The additive migration has already removed legacy orphans.
DROP INDEX IF EXISTS idx_observations_project;
CREATE TABLE verification_observations_with_project (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  outcome TEXT NOT NULL,
  run_id TEXT,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO verification_observations_with_project
SELECT id, project_id, head_sha, outcome, run_id, observed_at FROM verification_observations;
DROP TABLE verification_observations;
ALTER TABLE verification_observations_with_project RENAME TO verification_observations;
CREATE INDEX idx_observations_project ON verification_observations(project_id, observed_at);
CREATE TRIGGER project_membership_guards_verification_observations
BEFORE INSERT ON verification_observations WHEN
  EXISTS (
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

DROP TRIGGER IF EXISTS queue_state_backfills_project;

CREATE TABLE queue_state_with_project (
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  document TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, base_ref),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO queue_state_with_project
SELECT github_repository_id, base_ref, generation, document, updated_at, project_id FROM queue_state;
DROP TABLE queue_state;
ALTER TABLE queue_state_with_project RENAME TO queue_state;

DROP TRIGGER IF EXISTS queue_projects_backfills_project;
DROP TRIGGER IF EXISTS queue_status_comments_backfills_project;
DROP TRIGGER IF EXISTS queue_runners_backfills_project;
DROP TRIGGER IF EXISTS queue_assignments_backfills_project;
DROP TRIGGER IF EXISTS candidate_dispatches_backfills_project;
DROP TRIGGER IF EXISTS candidate_verdicts_backfills_project;
DROP TRIGGER IF EXISTS queue_attestations_backfills_project;
DROP TRIGGER IF EXISTS queue_transitions_index_backfills_project;
DROP TRIGGER IF EXISTS queue_entries_index_backfills_project;
DROP TRIGGER IF EXISTS queue_projection_marks_backfills_project;


-- Finish the additive ownership rollout. A nullable column plus an INSERT
-- trigger is not a durable incarnation boundary: a delayed writer could still
-- update or delete a row that now belongs to a later project. Rebuild every
-- repository-keyed queue table with mandatory ownership and cascading cleanup.
CREATE TABLE queue_status_comments_with_project (
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL,
  comment_id INTEGER,
  fingerprint TEXT,
  updated_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, base_ref, pull_request_number),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO queue_status_comments_with_project
SELECT github_repository_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at, project_id
  FROM queue_status_comments;
DROP TABLE queue_status_comments;
ALTER TABLE queue_status_comments_with_project RENAME TO queue_status_comments;

CREATE TABLE queue_runners_with_project (
  github_repository_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  device_key_id TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, principal_id, device_key_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO queue_runners_with_project
SELECT github_repository_id, principal_id, device_key_id, last_heartbeat_at, project_id FROM queue_runners;
DROP TABLE queue_runners;
ALTER TABLE queue_runners_with_project RENAME TO queue_runners;
CREATE INDEX queue_runners_repo_principal ON queue_runners (github_repository_id, principal_id);

CREATE TABLE queue_assignments_with_project (
  assignment_id TEXT PRIMARY KEY,
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  assignment_digest TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  candidate_tree_oid TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  device_key_id TEXT NOT NULL,
  required_suites TEXT NOT NULL,
  execution_seconds INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  receipt_digest TEXT,
  receipt_suites TEXT,
  receipt_accepted_at TEXT,
  project_id TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO queue_assignments_with_project
SELECT assignment_id, github_repository_id, base_ref, attempt_id, assignment_digest,
       candidate_sha, candidate_tree_oid, principal_id, device_key_id, required_suites,
       execution_seconds, issued_at, receipt_digest, receipt_suites, receipt_accepted_at, project_id
  FROM queue_assignments;
DROP TABLE queue_assignments;
ALTER TABLE queue_assignments_with_project RENAME TO queue_assignments;
CREATE UNIQUE INDEX queue_assignments_one_per_attempt ON queue_assignments (attempt_id);
CREATE INDEX queue_assignments_repository ON queue_assignments (github_repository_id, base_ref);

CREATE TABLE candidate_dispatches_with_project (
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  candidate_tree_oid TEXT NOT NULL,
  dispatched_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  attempt_id TEXT,
  workflow_protocol INTEGER NOT NULL CHECK (workflow_protocol IN (1, 2)),
  PRIMARY KEY (github_repository_id, base_ref, candidate_tree_oid),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO candidate_dispatches_with_project
SELECT github_repository_id, base_ref, candidate_tree_oid, dispatched_at, project_id,
       attempt_id, workflow_protocol
  FROM candidate_dispatches;
DROP TABLE candidate_dispatches;
ALTER TABLE candidate_dispatches_with_project RENAME TO candidate_dispatches;

CREATE TABLE candidate_verdicts_with_project (
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  candidate_tree_oid TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  result_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  suites TEXT NOT NULL,
  reason_codes TEXT NOT NULL,
  workflow_ref TEXT NOT NULL,
  workflow_sha TEXT NOT NULL,
  run_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, base_ref, candidate_tree_oid),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO candidate_verdicts_with_project
SELECT github_repository_id, base_ref, candidate_tree_oid, candidate_sha, base_sha,
       pull_request_number, accepted, result_digest, policy_digest, suites, reason_codes,
       workflow_ref, workflow_sha, run_id, observed_at, project_id
  FROM candidate_verdicts;
DROP TABLE candidate_verdicts;
ALTER TABLE candidate_verdicts_with_project RENAME TO candidate_verdicts;

CREATE TABLE queue_attestations_with_project (
  digest TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  transition_sequence INTEGER,
  attempt_id TEXT,
  bytes TEXT NOT NULL,
  jws TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  mirrored_at TEXT,
  project_id TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO queue_attestations_with_project
SELECT digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id,
       bytes, jws, created_at, mirrored_at, project_id FROM queue_attestations;
DROP TABLE queue_attestations;
ALTER TABLE queue_attestations_with_project RENAME TO queue_attestations;
CREATE INDEX idx_queue_attestations_chain
  ON queue_attestations(github_repository_id, base_ref, transition_sequence);
CREATE UNIQUE INDEX idx_queue_attestations_one_record_per_attempt
  ON queue_attestations(attempt_id) WHERE transition_sequence IS NOT NULL;

CREATE TABLE queue_transitions_index_with_project (
  id TEXT PRIMARY KEY,
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  queue_epoch INTEGER NOT NULL,
  transition_sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  prior_digest TEXT,
  base_sha TEXT NOT NULL,
  attempt_id TEXT,
  witness_count INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT,
  project_id TEXT NOT NULL,
  UNIQUE (github_repository_id, base_ref, queue_epoch, transition_sequence),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO queue_transitions_index_with_project
SELECT id, github_repository_id, base_ref, queue_epoch, transition_sequence, kind,
       digest, prior_digest, base_sha, attempt_id, witness_count, observed_at, project_id
  FROM queue_transitions_index;
DROP TABLE queue_transitions_index;
ALTER TABLE queue_transitions_index_with_project RENAME TO queue_transitions_index;
CREATE INDEX queue_transitions_by_repo
  ON queue_transitions_index (github_repository_id, base_ref, transition_sequence);

CREATE TABLE queue_entries_index_with_project (
  id TEXT PRIMARY KEY,
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL,
  sponsor_principal_id TEXT NOT NULL,
  state TEXT NOT NULL,
  primary_reason TEXT,
  fairness_ordinal TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  scheduler_eligible INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  last_attempt_id TEXT,
  head_sha TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  terminal_comment_priority INTEGER NOT NULL DEFAULT 0,
  project_id TEXT NOT NULL,
  UNIQUE (github_repository_id, base_ref, entry_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO queue_entries_index_with_project
SELECT id, github_repository_id, base_ref, entry_id, pull_request_number,
       sponsor_principal_id, state, primary_reason, fairness_ordinal, updated_at,
       scheduler_eligible, cooldown_until, last_attempt_id, head_sha, generation,
       terminal_comment_priority, project_id
  FROM queue_entries_index;
DROP TABLE queue_entries_index;
ALTER TABLE queue_entries_index_with_project RENAME TO queue_entries_index;
CREATE INDEX queue_entries_by_repo ON queue_entries_index (github_repository_id, base_ref, state);

CREATE TABLE queue_projection_marks_with_project (
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  projected_at TEXT NOT NULL DEFAULT (datetime('now')),
  active_attempt_id TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  rebaseline_required INTEGER NOT NULL DEFAULT 0,
  base_sha TEXT,
  queue_epoch INTEGER NOT NULL DEFAULT 0,
  project_id TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, base_ref),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO queue_projection_marks_with_project
SELECT github_repository_id, base_ref, generation, projected_at, active_attempt_id,
       paused, pause_reason, rebaseline_required, base_sha, queue_epoch, project_id
  FROM queue_projection_marks;
DROP TABLE queue_projection_marks;
ALTER TABLE queue_projection_marks_with_project RENAME TO queue_projection_marks;

CREATE TABLE queue_projects_with_project (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  activation_state TEXT NOT NULL DEFAULT 'configured',
  verifier_json TEXT,
  bootstrap_progress_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  attested_from_sequence INTEGER NOT NULL DEFAULT 0,
  chain_public INTEGER NOT NULL DEFAULT 0,
  project_id TEXT NOT NULL,
  verifier_workflow_version INTEGER NOT NULL DEFAULT 1
    CHECK (verifier_workflow_version IN (1, 2)),
  UNIQUE (github_repository_id, base_ref),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
INSERT INTO queue_projects_with_project
SELECT id, organization_id, github_repository_id, base_ref, enabled, activation_state,
       verifier_json, bootstrap_progress_json, created_at, attested_from_sequence, chain_public, project_id,
       verifier_workflow_version
  FROM queue_projects;
DROP TABLE queue_projects;
ALTER TABLE queue_projects_with_project RENAME TO queue_projects;

DROP TRIGGER IF EXISTS removed_project_blocks_team_repos;
DROP TRIGGER IF EXISTS removed_project_blocks_queue_status_comments;
DROP TRIGGER IF EXISTS removed_project_blocks_queue_runners;
DROP TRIGGER IF EXISTS removed_project_blocks_queue_assignments;
DROP TRIGGER IF EXISTS removed_project_blocks_candidate_dispatches;
DROP TRIGGER IF EXISTS removed_project_blocks_candidate_verdicts;
DROP TRIGGER IF EXISTS removed_project_blocks_queue_attestations;
DROP TRIGGER IF EXISTS removed_project_blocks_queue_transitions_index;
DROP TRIGGER IF EXISTS removed_project_blocks_queue_entries_index;
DROP TRIGGER IF EXISTS removed_project_blocks_queue_projection_marks;
DROP TRIGGER IF EXISTS removed_project_blocks_queue_state;
DROP TRIGGER IF EXISTS removed_project_blocks_queue_projects;

DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_repositories_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_repositories_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_sync_repositories_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_repository_authority_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_repository_authority_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_repository_authority_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_repository_reconcile_leases_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_repository_reconcile_leases_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_github_repository_reconcile_leases_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_reimport_quarantines_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_reimport_quarantines_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_reimport_quarantines_delete;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_lifecycle_backfills_insert;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_lifecycle_backfills_update;
DROP TRIGGER IF EXISTS project_lifecycle_maintenance_project_lifecycle_backfills_delete;

DROP INDEX IF EXISTS project_deletion_audits_repository;
DROP TABLE IF EXISTS project_deletion_audits;
DROP TABLE IF EXISTS removed_projects;

-- Repository-keyed state may be written by an old queued delivery. Accept it
-- only while the repository still has a project and no release is in progress.
CREATE TRIGGER project_membership_guards_team_repos
BEFORE INSERT ON team_repos WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.organization_id = NEW.organization_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_queue_status_comments
BEFORE INSERT ON queue_status_comments WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_queue_runners
BEFORE INSERT ON queue_runners WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_queue_assignments
BEFORE INSERT ON queue_assignments WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_candidate_dispatches
BEFORE INSERT ON candidate_dispatches WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_candidate_verdicts
BEFORE INSERT ON candidate_verdicts WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_queue_attestations
BEFORE INSERT ON queue_attestations WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_queue_transitions_index
BEFORE INSERT ON queue_transitions_index WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_queue_entries_index
BEFORE INSERT ON queue_entries_index WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_queue_projection_marks
BEFORE INSERT ON queue_projection_marks WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_queue_state
BEFORE INSERT ON queue_state WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_queue_projects
BEFORE INSERT ON queue_projects WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

-- Keep the existing R2 bucket and active generation. Evidence already uses the
-- exact project incarnation in its key. Expired write intents are recovered by
-- the bounded drainer rather than by replacing storage infrastructure.

-- This is the final half of the cleanup gate. Keep service maintenance active:
-- 0032 and 0033 are the next guarded before-worker phase, and 0034 is the only
-- migration allowed to reopen traffic after the exact compatible Worker proves
-- that complete schema live. The Worker-level maintenance gate replaces the
-- table triggers removed above and keeps every route, queue, and cron fenced.
UPDATE project_lifecycle_rollout
   SET destructive_schema_ready_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = 1 AND maintenance_mode = 1;
