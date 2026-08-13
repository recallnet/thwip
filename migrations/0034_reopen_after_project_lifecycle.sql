-- DEPLOY ORDER: after-worker
-- This is the only operation that reopens the service after the #398 storage
-- cutover. The migration runner also requires the exact clean Worker build and
-- its public v3 schema health. These SQL guards make a direct or misordered
-- application fail atomically while maintenance remains active.

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
       AND remote_capabilities_retired_at IS NOT NULL
       AND unixepoch(remote_capabilities_retired_at) IS NOT NULL
       AND unixepoch(remote_capabilities_retired_at) <= unixepoch('now')
       AND remote_capability_evidence IS NOT NULL
       AND json_valid(remote_capability_evidence) = 1
       AND destructive_schema_ready_at IS NOT NULL
       AND unixepoch(destructive_schema_ready_at) IS NOT NULL
       AND json_type(remote_capability_evidence, '$.d1.oldDatabase') = 'text'
       AND json_type(remote_capability_evidence, '$.d1.newDatabase') = 'text'
       AND length(trim(json_extract(remote_capability_evidence, '$.d1.oldDatabase'))) > 0
       AND length(trim(json_extract(remote_capability_evidence, '$.d1.newDatabase'))) > 0
       AND json_extract(remote_capability_evidence, '$.d1.oldDatabase')
           <> json_extract(remote_capability_evidence, '$.d1.newDatabase')
       AND json_type(remote_capability_evidence, '$.d1.oldDatabaseId') = 'text'
       AND json_type(remote_capability_evidence, '$.d1.newDatabaseId') = 'text'
       AND length(trim(json_extract(remote_capability_evidence, '$.d1.oldDatabaseId'))) > 0
       AND length(trim(json_extract(remote_capability_evidence, '$.d1.newDatabaseId'))) > 0
       AND json_extract(remote_capability_evidence, '$.d1.oldDatabaseId')
           <> json_extract(remote_capability_evidence, '$.d1.newDatabaseId')
       AND json_type(remote_capability_evidence, '$.d1.maintenanceEnabledAt') = 'text'
       AND json_type(remote_capability_evidence, '$.d1.exportCompletedAt') = 'text'
       AND json_type(remote_capability_evidence, '$.d1.importCompletedAt') = 'text'
       AND json_type(remote_capability_evidence, '$.d1.newDatabaseRoundTripAt') = 'text'
       AND json_type(remote_capability_evidence, '$.d1.newBindingActivatedAt') = 'text'
       AND json_type(remote_capability_evidence, '$.d1.oldDatabaseDeletedAt') = 'text'
       AND unixepoch(json_extract(remote_capability_evidence, '$.d1.maintenanceEnabledAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.d1.exportCompletedAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.d1.importCompletedAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.d1.newDatabaseRoundTripAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.d1.newBindingActivatedAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.d1.oldDatabaseDeletedAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.d1.maintenanceEnabledAt'))
           <= unixepoch(json_extract(remote_capability_evidence, '$.d1.exportCompletedAt'))
       AND unixepoch(json_extract(remote_capability_evidence, '$.d1.exportCompletedAt'))
           <= unixepoch(json_extract(remote_capability_evidence, '$.d1.importCompletedAt'))
       AND unixepoch(json_extract(remote_capability_evidence, '$.d1.importCompletedAt'))
           <= unixepoch(json_extract(remote_capability_evidence, '$.d1.newDatabaseRoundTripAt'))
       AND unixepoch(json_extract(remote_capability_evidence, '$.d1.importCompletedAt'))
           <= unixepoch(json_extract(remote_capability_evidence, '$.d1.newBindingActivatedAt'))
       AND unixepoch(json_extract(remote_capability_evidence, '$.d1.newBindingActivatedAt'))
           <= unixepoch(json_extract(remote_capability_evidence, '$.d1.oldDatabaseDeletedAt'))
       AND unixepoch(remote_capabilities_retired_at)
           >= unixepoch(json_extract(remote_capability_evidence, '$.d1.maintenanceEnabledAt'))
       AND unixepoch(remote_capabilities_retired_at)
           >= unixepoch(json_extract(remote_capability_evidence, '$.d1.exportCompletedAt'))
       AND unixepoch(remote_capabilities_retired_at)
           >= unixepoch(json_extract(remote_capability_evidence, '$.d1.importCompletedAt'))
       AND unixepoch(remote_capabilities_retired_at)
           >= unixepoch(json_extract(remote_capability_evidence, '$.d1.newDatabaseRoundTripAt'))
       AND unixepoch(remote_capabilities_retired_at)
           >= unixepoch(json_extract(remote_capability_evidence, '$.d1.newBindingActivatedAt'))
       AND json_type(remote_capability_evidence, '$.d1.exportSha256') = 'text'
       AND json_type(remote_capability_evidence, '$.d1.schemaSha256') = 'text'
       AND json_type(remote_capability_evidence, '$.d1.rowCountSha256') = 'text'
       AND length(json_extract(remote_capability_evidence, '$.d1.exportSha256')) = 64
       AND json_extract(remote_capability_evidence, '$.d1.exportSha256') NOT GLOB '*[^0-9a-f]*'
       AND length(json_extract(remote_capability_evidence, '$.d1.schemaSha256')) = 64
       AND json_extract(remote_capability_evidence, '$.d1.schemaSha256') NOT GLOB '*[^0-9a-f]*'
       AND length(json_extract(remote_capability_evidence, '$.d1.rowCountSha256')) = 64
       AND json_extract(remote_capability_evidence, '$.d1.rowCountSha256') NOT GLOB '*[^0-9a-f]*'
       AND json_extract(remote_capability_evidence, '$.d1.quickCheck') = 'ok'
       AND json_type(remote_capability_evidence, '$.d1.foreignKeyViolations') = 'integer'
       AND json_extract(remote_capability_evidence, '$.d1.foreignKeyViolations') = 0
       AND json_type(remote_capability_evidence, '$.r2.oldBucket') = 'text'
       AND json_type(remote_capability_evidence, '$.r2.newBucket') = 'text'
       AND length(trim(json_extract(remote_capability_evidence, '$.r2.oldBucket'))) > 0
       AND length(trim(json_extract(remote_capability_evidence, '$.r2.newBucket'))) > 0
       AND json_extract(remote_capability_evidence, '$.r2.oldBucket')
           <> json_extract(remote_capability_evidence, '$.r2.newBucket')
       AND json_type(remote_capability_evidence, '$.r2.copyCompletedAt') = 'text'
       AND json_type(remote_capability_evidence, '$.r2.newBucketRoundTripAt') = 'text'
       AND json_type(remote_capability_evidence, '$.r2.oldBucketDeletedAt') = 'text'
       AND unixepoch(json_extract(remote_capability_evidence, '$.r2.copyCompletedAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.r2.newBucketRoundTripAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.r2.oldBucketDeletedAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.r2.copyCompletedAt'))
           <= unixepoch(json_extract(remote_capability_evidence, '$.r2.newBucketRoundTripAt'))
       AND unixepoch(json_extract(remote_capability_evidence, '$.r2.newBucketRoundTripAt'))
           <= unixepoch(json_extract(remote_capability_evidence, '$.r2.oldBucketDeletedAt'))
       AND json_type(remote_capability_evidence, '$.github.oldKeyFingerprint') = 'text'
       AND json_type(remote_capability_evidence, '$.github.newKeyFingerprint') = 'text'
       AND length(trim(json_extract(remote_capability_evidence, '$.github.oldKeyFingerprint'))) > 0
       AND length(trim(json_extract(remote_capability_evidence, '$.github.newKeyFingerprint'))) > 0
       AND json_extract(remote_capability_evidence, '$.github.oldKeyFingerprint')
           <> json_extract(remote_capability_evidence, '$.github.newKeyFingerprint')
       AND json_type(remote_capability_evidence, '$.github.newKeyAcceptedAt') = 'text'
       AND json_type(remote_capability_evidence, '$.github.oldPrivateKeyDeletedAt') = 'text'
       AND json_type(remote_capability_evidence, '$.github.oldKeyRejectedAt') = 'text'
       AND json_type(remote_capability_evidence, '$.github.oldInstallationTokensExpiredAt') = 'text'
       AND json_type(remote_capability_evidence, '$.github.oldInstallationTokenRejectedAt') = 'text'
       AND unixepoch(json_extract(remote_capability_evidence, '$.github.newKeyAcceptedAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.github.oldPrivateKeyDeletedAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.github.oldKeyRejectedAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.github.oldInstallationTokensExpiredAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.github.oldInstallationTokenRejectedAt')) IS NOT NULL
       AND unixepoch(json_extract(remote_capability_evidence, '$.github.newKeyAcceptedAt'))
           <= unixepoch(json_extract(remote_capability_evidence, '$.github.oldPrivateKeyDeletedAt'))
       AND unixepoch(json_extract(remote_capability_evidence, '$.github.oldPrivateKeyDeletedAt'))
           <= unixepoch(json_extract(remote_capability_evidence, '$.github.oldKeyRejectedAt'))
       AND unixepoch(json_extract(remote_capability_evidence, '$.github.oldInstallationTokensExpiredAt'))
           >= unixepoch(json_extract(remote_capability_evidence, '$.github.oldPrivateKeyDeletedAt')) + 3600
       AND unixepoch(json_extract(remote_capability_evidence, '$.github.oldInstallationTokenRejectedAt'))
           >= unixepoch(json_extract(remote_capability_evidence, '$.github.oldInstallationTokensExpiredAt'))
       AND unixepoch(remote_capabilities_retired_at)
           >= unixepoch(json_extract(remote_capability_evidence, '$.d1.oldDatabaseDeletedAt'))
       AND unixepoch(remote_capabilities_retired_at)
           >= unixepoch(json_extract(remote_capability_evidence, '$.r2.oldBucketDeletedAt'))
       AND unixepoch(remote_capabilities_retired_at)
           >= unixepoch(json_extract(remote_capability_evidence, '$.github.oldInstallationTokenRejectedAt'))
       AND unixepoch(remote_capabilities_retired_at)
           >= unixepoch(json_extract(remote_capability_evidence, '$.github.oldKeyRejectedAt'))
       AND json_type(remote_capability_evidence, '$.approvedBy') = 'text'
       AND length(trim(json_extract(remote_capability_evidence, '$.approvedBy'))) > 0
       AND json_type(remote_capability_evidence, '$.changeUrl') = 'text'
       AND json_extract(remote_capability_evidence, '$.changeUrl') LIKE 'https://%'
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
