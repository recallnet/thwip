-- App-native proof verification and organization-managed defaults.
--
-- Repository thwip.yaml remains authoritative when present. The organization
-- JSON supplies a complete default document for repositories that choose not
-- to commit one.
ALTER TABLE organizations ADD COLUMN proof_defaults_json TEXT;
ALTER TABLE projects ADD COLUMN proof_check_mode TEXT NOT NULL DEFAULT 'observe';
ALTER TABLE policy_bundles ADD COLUMN config_source TEXT NOT NULL DEFAULT 'repository-override';

-- A layered policy can change because either the organization defaults or the
-- repository override changed. Their human-facing version numbers are not
-- composable, so the digest remains the identity and (project_id, version) is
-- no longer unique.
CREATE TABLE policy_bundles_v2 (
  digest TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  activated_at TEXT,
  source_ref TEXT,
  source_sha TEXT,
  config_source TEXT NOT NULL DEFAULT 'repository-override'
);

INSERT INTO policy_bundles_v2
  (digest, project_id, version, canonical_json, status, created_at, activated_at,
   source_ref, source_sha, config_source)
SELECT digest, project_id, version, canonical_json, status, created_at, activated_at,
       source_ref, source_sha, config_source
  FROM policy_bundles;

DROP TABLE policy_bundles;
ALTER TABLE policy_bundles_v2 RENAME TO policy_bundles;

CREATE INDEX idx_policy_bundles_source
  ON policy_bundles(project_id, source_ref, source_sha);

-- One immutable row per evaluation attempt. A rerequest or policy/key change
-- creates a new check run and audit row rather than allowing an older worker to
-- overwrite a newer check run with the same name.
CREATE TABLE proof_verifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  event TEXT NOT NULL,
  subject_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  policy_digest TEXT,
  verifier_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  outcome TEXT,
  detail TEXT,
  check_name TEXT NOT NULL,
  check_run_id TEXT,
  audit_jws TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE INDEX idx_proof_verifications_subject
  ON proof_verifications(project_id, subject_sha, started_at);

CREATE INDEX idx_proof_verifications_check_run
  ON proof_verifications(check_run_id);
