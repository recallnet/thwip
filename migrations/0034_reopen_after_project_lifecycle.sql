-- DEPLOY ORDER: after-worker
-- Reopen after the in-place #398 schema change. The migration runner also
-- requires the exact clean Worker build and its public v3 schema health. These
-- SQL guards make a direct or misordered application fail atomically while
-- maintenance remains active.

CREATE TABLE project_lifecycle_reopen_guard (ready INTEGER NOT NULL CHECK (ready = 1));
INSERT INTO project_lifecycle_reopen_guard
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0031_finish_github_repository_lifecycle.sql')
  AND EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0032_private_agent_feedback_foundation.sql')
  AND EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0033_verifier_protocol_v3.sql')
  AND EXISTS (
    SELECT 1 FROM project_lifecycle_rollout
     WHERE id = 1
       AND maintenance_mode = 1
       AND worker_activated_at IS NOT NULL
       AND length(worker_build_sha) >= 7
       AND length(worker_deployment_id) = 36
       AND substr(worker_deployment_id, 9, 1) = '-'
       AND substr(worker_deployment_id, 14, 1) = '-'
       AND substr(worker_deployment_id, 19, 1) = '-'
       AND substr(worker_deployment_id, 24, 1) = '-'
       AND substr(worker_deployment_id, 15, 1) GLOB '[1-8]'
       AND lower(substr(worker_deployment_id, 20, 1)) GLOB '[89ab]'
       AND length(replace(worker_deployment_id, '-', '')) = 32
       AND lower(worker_deployment_id) NOT GLOB '*[^0-9a-f-]*'
       AND length(verifier_v3_predeploy_id) = 36
       AND substr(verifier_v3_predeploy_id, 9, 1) = '-'
       AND substr(verifier_v3_predeploy_id, 14, 1) = '-'
       AND substr(verifier_v3_predeploy_id, 19, 1) = '-'
       AND substr(verifier_v3_predeploy_id, 24, 1) = '-'
       AND substr(verifier_v3_predeploy_id, 15, 1) GLOB '[1-8]'
       AND lower(substr(verifier_v3_predeploy_id, 20, 1)) GLOB '[89ab]'
       AND length(replace(verifier_v3_predeploy_id, '-', '')) = 32
       AND lower(verifier_v3_predeploy_id) NOT GLOB '*[^0-9a-f-]*'
       AND worker_deployment_id <> verifier_v3_predeploy_id
       AND destructive_schema_ready_at IS NOT NULL
       AND unixepoch(destructive_schema_ready_at) IS NOT NULL
  )
  AND (SELECT count(*) FROM project_lifecycle_backfills) = 11
  AND NOT EXISTS (
    SELECT 1 FROM project_lifecycle_backfills
     WHERE completed_at IS NULL OR verified_row_count IS NULL
  )
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_report_retention_clock')
  AND EXISTS (SELECT 1 FROM pragma_table_info('queue_projects') WHERE name = 'verifier_protocol')
  AND EXISTS (SELECT 1 FROM pragma_table_info('candidate_dispatches') WHERE name = 'dispatch_nonce')
  AND EXISTS (SELECT 1 FROM pragma_table_info('candidate_verdicts') WHERE name = 'verifier_protocol')
THEN 1 ELSE 0 END;
DROP TABLE project_lifecycle_reopen_guard;

-- Final statement by design. No earlier statement may remove the service fence.
UPDATE project_lifecycle_rollout
   SET maintenance_mode = 0
 WHERE id = 1
   AND maintenance_mode = 1
   AND worker_build_sha IS NOT NULL
   AND destructive_schema_ready_at IS NOT NULL;
