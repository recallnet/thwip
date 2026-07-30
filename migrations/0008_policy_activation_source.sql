ALTER TABLE policy_bundles ADD COLUMN source_ref TEXT;
ALTER TABLE policy_bundles ADD COLUMN source_sha TEXT;

CREATE INDEX idx_policy_bundles_source
  ON policy_bundles(project_id, source_ref, source_sha);
