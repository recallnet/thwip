-- DEPLOY ORDER: before-worker
-- Thwip Queue projection (plan.md §41.1).
-- The Durable Object is live authority; these tables serve organization-wide
-- reads, the dashboard, and exports, and may lag behind the object.

CREATE TABLE IF NOT EXISTS queue_projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  backend TEXT NOT NULL DEFAULT 'managed',
  enabled INTEGER NOT NULL DEFAULT 0,
  -- 'configured' | 'observe' | 'canary' | 'enforced' (plan.md §4.8)
  activation_state TEXT NOT NULL DEFAULT 'configured',
  merge_method TEXT NOT NULL DEFAULT 'squash',
  -- The pinned verifier identity. A verdict is only accepted from this exact
  -- workflow path and commit, because any workflow in the repository can obtain
  -- a valid OIDC token for it.
  verifier_json TEXT,
  bootstrap_progress_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (github_repository_id, base_ref)
);

CREATE TABLE IF NOT EXISTS queue_entries_index (
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
  UNIQUE (github_repository_id, base_ref, entry_id)
);

CREATE TABLE IF NOT EXISTS queue_transitions_index (
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
  -- Distinct principals who have certified on top of this point (§24.1).
  witness_count INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  UNIQUE (github_repository_id, base_ref, queue_epoch, transition_sequence)
);

CREATE INDEX IF NOT EXISTS queue_entries_by_repo ON queue_entries_index (github_repository_id, base_ref, state);
CREATE INDEX IF NOT EXISTS queue_transitions_by_repo ON queue_transitions_index (github_repository_id, base_ref, transition_sequence);
