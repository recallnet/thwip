-- DEPLOY ORDER: before-worker
-- DEPLOY BLOCKER: 0031 and 0032 must be applied first. This migration is dark:
-- the live v2 Worker ignores every new column. Do not deploy the v3 Worker until
-- the operator-approved Phase 2 cutover has applied this file.
--
-- Protocol 3 separates candidate execution from verdict authority. A candidate
-- dispatch is bound to the exact default-branch workflow commit, blob and
-- content digest. The only OIDC caller registers a pending report. The App
-- later reads completed GitHub jobs and derives the verdict itself.

-- Snapshot the deployment generation serving before this barrier. Migration
-- 0034 requires a different generation, which proves a real post-0033 deploy
-- even when canonical main still has the same commit SHA.
UPDATE project_lifecycle_rollout
   SET verifier_v3_predeploy_id = worker_deployment_id
 WHERE id = 1 AND maintenance_mode = 1
   AND length(worker_deployment_id) = 36
   AND substr(worker_deployment_id, 9, 1) = '-'
   AND substr(worker_deployment_id, 14, 1) = '-'
   AND substr(worker_deployment_id, 19, 1) = '-'
   AND substr(worker_deployment_id, 24, 1) = '-'
   AND substr(worker_deployment_id, 15, 1) GLOB '[1-8]'
   AND lower(substr(worker_deployment_id, 20, 1)) GLOB '[89ab]'
   AND length(replace(worker_deployment_id, '-', '')) = 32
   AND lower(worker_deployment_id) NOT GLOB '*[^0-9a-f-]*';

CREATE TABLE verifier_v3_deploy_guard (ready INTEGER NOT NULL CHECK (ready = 1));
INSERT INTO verifier_v3_deploy_guard
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM project_lifecycle_rollout
   WHERE id = 1 AND maintenance_mode = 1
     AND length(verifier_v3_predeploy_id) = 36
     AND substr(verifier_v3_predeploy_id, 9, 1) = '-'
     AND substr(verifier_v3_predeploy_id, 14, 1) = '-'
     AND substr(verifier_v3_predeploy_id, 19, 1) = '-'
     AND substr(verifier_v3_predeploy_id, 24, 1) = '-'
     AND substr(verifier_v3_predeploy_id, 15, 1) GLOB '[1-8]'
     AND lower(substr(verifier_v3_predeploy_id, 20, 1)) GLOB '[89ab]'
     AND length(replace(verifier_v3_predeploy_id, '-', '')) = 32
     AND lower(verifier_v3_predeploy_id) NOT GLOB '*[^0-9a-f-]*'
) THEN 1 ELSE 0 END;
DROP TABLE verifier_v3_deploy_guard;

ALTER TABLE queue_projects ADD COLUMN verifier_protocol INTEGER NOT NULL DEFAULT 2
  CHECK (verifier_protocol IN (1, 2, 3));

-- Verdicts written before v3 are not evidence for the v3 trust boundary. The
-- activation transaction removes them, this marker makes that distinction
-- durable, and the read path also refuses a surviving v2 row after upgrade.
ALTER TABLE candidate_verdicts ADD COLUMN verifier_protocol INTEGER NOT NULL DEFAULT 2
  CHECK (verifier_protocol IN (1, 2, 3));

ALTER TABLE candidate_dispatches ADD COLUMN verifier_protocol INTEGER NOT NULL DEFAULT 2
  CHECK (verifier_protocol IN (1, 2, 3));
ALTER TABLE candidate_dispatches ADD COLUMN dispatch_nonce TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN workflow_commit_sha TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN workflow_blob_sha TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN workflow_content_digest TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN required_suites TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN policy_digest TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN pull_request_number INTEGER;
ALTER TABLE candidate_dispatches ADD COLUMN base_sha TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN candidate_sha TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN report_run_id TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN report_run_attempt INTEGER;
ALTER TABLE candidate_dispatches ADD COLUMN report_check_run_id TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN report_jti TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN pending_at TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN finalize_after TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN finalized_at TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN terminal_reason TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN finalizer_claim TEXT;
ALTER TABLE candidate_dispatches ADD COLUMN finalizer_claim_expires_at TEXT;

CREATE UNIQUE INDEX candidate_dispatches_nonce_v3
  ON candidate_dispatches(dispatch_nonce) WHERE dispatch_nonce IS NOT NULL;
CREATE UNIQUE INDEX candidate_dispatches_report_job_v3
  ON candidate_dispatches(report_run_id, report_run_attempt, report_check_run_id)
  WHERE report_check_run_id IS NOT NULL;
CREATE INDEX candidate_dispatches_pending_v3
  ON candidate_dispatches(finalize_after, dispatched_at)
  WHERE pending_at IS NOT NULL AND finalized_at IS NULL AND terminal_reason IS NULL;

-- Once a repository records v3, an old Worker must not silently put it back on
-- the vulnerable protocol. The migration remains compatible while the project
-- is still v1/v2; the guard activates only at the explicit upgrade commit.
CREATE TRIGGER queue_projects_blocks_verifier_protocol_downgrade
BEFORE UPDATE OF verifier_protocol ON queue_projects
WHEN OLD.verifier_protocol = 3 AND NEW.verifier_protocol <> 3
BEGIN
  SELECT RAISE(ABORT, 'verifier protocol downgrade blocked');
END;

-- The activation write is also the cutover transaction. It permanently
-- supersedes every callback issued by the old trust boundary and removes old
-- verdicts before the upgraded project can consume another queue turn.
CREATE TRIGGER queue_projects_activates_verifier_protocol_v3
AFTER UPDATE OF verifier_protocol ON queue_projects
WHEN OLD.verifier_protocol <> 3 AND NEW.verifier_protocol = 3
BEGIN
  UPDATE candidate_dispatches
     SET terminal_reason = 'superseded by verifier protocol v3',
         finalized_at = COALESCE(finalized_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
         finalizer_claim = NULL,
         finalizer_claim_expires_at = NULL
   WHERE github_repository_id = NEW.github_repository_id
     AND base_ref = NEW.base_ref AND project_id = NEW.project_id
     AND verifier_protocol <> 3 AND terminal_reason IS NULL;
  DELETE FROM candidate_verdicts
   WHERE github_repository_id = NEW.github_repository_id
     AND base_ref = NEW.base_ref AND project_id = NEW.project_id
     AND verifier_protocol <> 3;
END;

CREATE TRIGGER candidate_dispatches_require_active_verifier_protocol
BEFORE INSERT ON candidate_dispatches
WHEN EXISTS (
  SELECT 1 FROM queue_projects q
   WHERE q.github_repository_id = NEW.github_repository_id
     AND q.base_ref = NEW.base_ref
     AND q.project_id = NEW.project_id
     AND q.verifier_protocol = 3
) AND NEW.verifier_protocol <> 3
BEGIN
  SELECT RAISE(ABORT, 'verifier protocol downgrade blocked');
END;

CREATE TRIGGER candidate_dispatches_require_active_verifier_protocol_update
BEFORE UPDATE OF verifier_protocol ON candidate_dispatches
WHEN EXISTS (
  SELECT 1 FROM queue_projects q
   WHERE q.github_repository_id = NEW.github_repository_id
     AND q.base_ref = NEW.base_ref
     AND q.project_id = NEW.project_id
     AND q.verifier_protocol = 3
) AND NEW.verifier_protocol <> 3
BEGIN
  SELECT RAISE(ABORT, 'verifier protocol downgrade blocked');
END;

CREATE TRIGGER candidate_verdicts_require_active_verifier_protocol
BEFORE INSERT ON candidate_verdicts
WHEN EXISTS (
  SELECT 1 FROM queue_projects q
   WHERE q.github_repository_id = NEW.github_repository_id
     AND q.base_ref = NEW.base_ref
     AND q.project_id = NEW.project_id
     AND q.verifier_protocol = 3
) AND NEW.verifier_protocol <> 3
BEGIN
  SELECT RAISE(ABORT, 'verifier protocol downgrade blocked');
END;

CREATE TRIGGER candidate_verdicts_require_active_verifier_protocol_update
BEFORE UPDATE OF verifier_protocol ON candidate_verdicts
WHEN EXISTS (
  SELECT 1 FROM queue_projects q
   WHERE q.github_repository_id = NEW.github_repository_id
     AND q.base_ref = NEW.base_ref
     AND q.project_id = NEW.project_id
     AND q.verifier_protocol = 3
) AND NEW.verifier_protocol <> 3
BEGIN
  SELECT RAISE(ABORT, 'verifier protocol downgrade blocked');
END;

CREATE TRIGGER candidate_dispatches_v3_identity_immutable
BEFORE UPDATE OF dispatch_nonce, workflow_commit_sha, workflow_blob_sha,
  workflow_content_digest, required_suites, policy_digest, pull_request_number, base_sha,
  candidate_sha, report_run_id, report_run_attempt, report_check_run_id,
  report_jti ON candidate_dispatches
-- Before the report registers, the trusted dispatcher may replace a stale
-- claim with a new nonce. That invalidates any delayed old callback. From the
-- first authenticated report onward, every identity field is immutable.
WHEN OLD.verifier_protocol = 3 AND OLD.pending_at IS NOT NULL AND OLD.terminal_reason IS NULL AND (
  NEW.dispatch_nonce IS NOT OLD.dispatch_nonce OR
  NEW.workflow_commit_sha IS NOT OLD.workflow_commit_sha OR
  NEW.workflow_blob_sha IS NOT OLD.workflow_blob_sha OR
  NEW.workflow_content_digest IS NOT OLD.workflow_content_digest OR
  NEW.required_suites IS NOT OLD.required_suites OR
  NEW.policy_digest IS NOT OLD.policy_digest OR
  NEW.pull_request_number IS NOT OLD.pull_request_number OR
  NEW.base_sha IS NOT OLD.base_sha OR
  NEW.candidate_sha IS NOT OLD.candidate_sha OR
  (OLD.report_run_id IS NOT NULL AND NEW.report_run_id IS NOT OLD.report_run_id) OR
  (OLD.report_run_attempt IS NOT NULL AND NEW.report_run_attempt IS NOT OLD.report_run_attempt) OR
  (OLD.report_check_run_id IS NOT NULL AND NEW.report_check_run_id IS NOT OLD.report_check_run_id) OR
  (OLD.report_jti IS NOT NULL AND NEW.report_jti IS NOT OLD.report_jti)
)
BEGIN
  SELECT RAISE(ABORT, 'verifier v3 identity is immutable');
END;
