-- thwip control-plane schema (staging + production)
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  github_org_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  github_repository_id TEXT NOT NULL UNIQUE,
  github_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  enabled INTEGER NOT NULL DEFAULT 0,
  active_policy_digest TEXT,
  security_profile TEXT NOT NULL DEFAULT 'fast',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE (organization_id, github_user_id)
);

CREATE TABLE device_keys (
  key_id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  device_label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX idx_device_keys_user ON device_keys(github_user_id);
CREATE UNIQUE INDEX idx_device_keys_fingerprint ON device_keys(fingerprint);

CREATE TABLE repository_grants (
  project_id TEXT NOT NULL REFERENCES projects(id),
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  permission TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, github_user_id)
);

CREATE TABLE policy_bundles (
  digest TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  activated_at TEXT,
  UNIQUE (project_id, version)
);

CREATE TABLE enroll_challenges (
  challenge TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE webhook_deliveries (
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (provider, delivery_id)
);

CREATE TABLE verification_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  outcome TEXT NOT NULL,
  run_id TEXT,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_observations_project ON verification_observations(project_id, observed_at);

CREATE TABLE stripe_state (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'none',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
