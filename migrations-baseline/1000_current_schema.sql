-- DEPLOY ORDER: before-worker
-- Fresh-install baseline derived from the complete 0001-0034 schema.
-- It contains no tenant, repository, project, user, token, proof, queue, or production data.
-- Existing databases keep their historic ledger. New databases record only this baseline.

CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

CREATE TABLE agent_report_content (
  private_root_id TEXT PRIMARY KEY
    REFERENCES agent_report_private_roots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bug', 'feature')),
  title TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE agent_report_events (
  id TEXT PRIMARY KEY,
  private_root_id TEXT NOT NULL
    REFERENCES agent_report_private_roots(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('submitter', 'operator', 'system')),
  occurred_at TEXT NOT NULL
);

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

CREATE TABLE agent_report_retention_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  claim_token TEXT,
  claim_expires_at TEXT,
  last_started_at TEXT,
  last_finished_at TEXT,
  last_error_at TEXT,
  last_error TEXT
);

CREATE TABLE "candidate_dispatches" (
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  candidate_tree_oid TEXT NOT NULL,
  dispatched_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  attempt_id TEXT,
  workflow_protocol INTEGER NOT NULL CHECK (workflow_protocol IN (1, 2)), verifier_protocol INTEGER NOT NULL DEFAULT 2
  CHECK (verifier_protocol IN (1, 2, 3)), dispatch_nonce TEXT, workflow_commit_sha TEXT, workflow_blob_sha TEXT, workflow_content_digest TEXT, required_suites TEXT, policy_digest TEXT, pull_request_number INTEGER, base_sha TEXT, candidate_sha TEXT, report_run_id TEXT, report_run_attempt INTEGER, report_check_run_id TEXT, report_jti TEXT, pending_at TEXT, finalize_after TEXT, finalized_at TEXT, terminal_reason TEXT, finalizer_claim TEXT, finalizer_claim_expires_at TEXT,
  PRIMARY KEY (github_repository_id, base_ref, candidate_tree_oid),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE "candidate_verdicts" (
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
  project_id TEXT NOT NULL, verifier_protocol INTEGER NOT NULL DEFAULT 2
  CHECK (verifier_protocol IN (1, 2, 3)),
  PRIMARY KEY (github_repository_id, base_ref, candidate_tree_oid),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE "deviceCode" ("id" text not null primary key, "deviceCode" text not null, "userCode" text not null, "userId" text, "expiresAt" date not null, "status" text not null, "lastPolledAt" date, "pollingInterval" integer, "clientId" text, "scope" text);

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
, source TEXT NOT NULL DEFAULT 'github');

CREATE TABLE enroll_challenges (
  challenge TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE github_repository_authority (
  github_repository_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (github_repository_id, installation_id)
);

CREATE TABLE github_repository_reconcile_leases (
  github_repository_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  expires_at TEXT NOT NULL
);

CREATE TABLE github_sync_grants (
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

CREATE TABLE github_sync_people (
  snapshot_id TEXT NOT NULL,
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  github_org_role TEXT NOT NULL,
  avatar_url TEXT,
  PRIMARY KEY (snapshot_id, authority_pass, github_user_id),
  FOREIGN KEY (snapshot_id) REFERENCES github_sync_snapshots(id) ON DELETE CASCADE
);

CREATE TABLE github_sync_repositories (
  snapshot_id TEXT NOT NULL,
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  github_repository_id TEXT NOT NULL,
  github_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, authority_pass, github_repository_id),
  FOREIGN KEY (snapshot_id) REFERENCES github_sync_snapshots(id) ON DELETE CASCADE
);

CREATE TABLE github_sync_snapshots (
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

CREATE TABLE github_sync_team_members (
  snapshot_id TEXT NOT NULL,
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  team_id TEXT NOT NULL,
  github_user_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, authority_pass, team_id, github_user_id),
  FOREIGN KEY (snapshot_id) REFERENCES github_sync_snapshots(id) ON DELETE CASCADE
);

CREATE TABLE github_sync_team_repos (
  snapshot_id TEXT NOT NULL,
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  team_id TEXT NOT NULL,
  github_repository_id TEXT NOT NULL,
  project_id TEXT,
  permission TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, authority_pass, team_id, github_repository_id),
  FOREIGN KEY (snapshot_id) REFERENCES github_sync_snapshots(id) ON DELETE CASCADE
);

CREATE TABLE github_sync_teams (
  snapshot_id TEXT NOT NULL,
  authority_pass INTEGER NOT NULL DEFAULT 1 CHECK (authority_pass BETWEEN 1 AND 3),
  team_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, authority_pass, team_id),
  FOREIGN KEY (snapshot_id) REFERENCES github_sync_snapshots(id) ON DELETE CASCADE
);

CREATE TABLE github_teams (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  team_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (organization_id, team_id)
);

CREATE TABLE installation_sync_leases (
  installation_id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE "invitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" date not null, "createdAt" date not null, "inviterId" text not null references "user" ("id") on delete cascade);

CREATE TABLE "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" date not null);

CREATE TABLE "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" date not null, "metadata" text);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  github_org_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
, installation_id TEXT, better_auth_org_id TEXT, proof_defaults_json TEXT, repository_selection TEXT
  CHECK (repository_selection IN ('all', 'selected')));

CREATE TABLE "policy_bundles" (
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

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  activated_at TEXT, github_org_role TEXT, avatar_url TEXT, better_auth_user_id TEXT,
  UNIQUE (organization_id, github_user_id)
);

CREATE TABLE project_legacy_cleanup_scopes (
  github_repository_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_attempted_at TEXT,
  cleanup_owner_token TEXT,
  cleanup_lease_expires_at TEXT,
  PRIMARY KEY (github_repository_id, organization_id)
);

CREATE TABLE project_lifecycle_backfills (
  table_name TEXT PRIMARY KEY,
  completed_at TEXT,
  verified_row_count INTEGER,
  CHECK (verified_row_count IS NULL OR verified_row_count >= 0)
);

CREATE TABLE project_lifecycle_rollout (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  maintenance_mode INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_mode IN (0, 1)),
  worker_activated_at TEXT,
  worker_build_sha TEXT,
  worker_deployment_id TEXT,
  verifier_v3_predeploy_id TEXT,
  remote_capabilities_retired_at TEXT,
  remote_capability_evidence TEXT,
  destructive_schema_ready_at TEXT,
  CHECK (
    (remote_capabilities_retired_at IS NULL AND remote_capability_evidence IS NULL)
    OR (remote_capabilities_retired_at IS NOT NULL AND length(remote_capability_evidence) > 0)
  )
);

CREATE TABLE project_r2_capability_generations (
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

CREATE TABLE project_r2_cleanup_intents (
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

CREATE TABLE project_reimport_quarantines (
  github_repository_id TEXT PRIMARY KEY,
  prior_project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  reimport_not_before TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE project_release_evidence_scopes (
  github_repository_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, prefix),
  FOREIGN KEY (github_repository_id) REFERENCES project_release_jobs(github_repository_id) ON DELETE CASCADE
);

CREATE TABLE project_release_jobs (
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

CREATE TABLE project_release_queue_refs (
  project_id TEXT NOT NULL,
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  PRIMARY KEY (project_id, base_ref),
  FOREIGN KEY (github_repository_id) REFERENCES project_release_jobs(github_repository_id) ON DELETE CASCADE
);

CREATE TABLE project_release_requests (
  github_repository_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  github_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_attempted_at TEXT
);

CREATE TABLE project_write_leases (
  github_repository_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, owner_token)
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
, proof_check_mode TEXT NOT NULL DEFAULT 'observe');

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
, signed_suite_duration_ms INTEGER, signed_wall_clock_duration_ms INTEGER, verification_duration_ms INTEGER);

CREATE TABLE "queue_assignments" (
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

CREATE TABLE "queue_attestations" (
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

CREATE TABLE queue_clock (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  -- 'cron' or 'traffic', so the tail says which clock is carrying the queue.
  source TEXT NOT NULL
, last_error TEXT, last_error_at TEXT);

CREATE TABLE "queue_entries_index" (
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

CREATE TABLE "queue_projection_marks" (
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

CREATE TABLE "queue_projects" (
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
    CHECK (verifier_workflow_version IN (1, 2)), verifier_protocol INTEGER NOT NULL DEFAULT 2
  CHECK (verifier_protocol IN (1, 2, 3)),
  UNIQUE (github_repository_id, base_ref),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE "queue_runners" (
  github_repository_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  device_key_id TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, principal_id, device_key_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE "queue_state" (
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  document TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, base_ref),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE "queue_status_comments" (
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

CREATE TABLE "queue_transitions_index" (
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

CREATE TABLE repository_grants (
  project_id TEXT NOT NULL REFERENCES projects(id),
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  permission TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, github_user_id)
);

CREATE TABLE service_keys (
  kid TEXT PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Set when the key stops signing. It still verifies everything it signed.
  retired_at TEXT
);

CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "activeOrganizationId" text);

CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE stripe_state (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'none',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE "subscription" ("id" text not null primary key, "plan" text not null, "referenceId" text not null, "stripeCustomerId" text, "stripeSubscriptionId" text, "status" text not null, "periodStart" date, "periodEnd" date, "trialStart" date, "trialEnd" date, "cancelAtPeriodEnd" integer, "cancelAt" date, "canceledAt" date, "endedAt" date, "seats" integer, "billingInterval" text, "stripeScheduleId" text);

CREATE TABLE team_members (
  organization_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  github_user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (organization_id, team_id, github_user_id)
);

CREATE TABLE team_repos (
  organization_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  github_repository_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (organization_id, team_id, github_repository_id)
);

CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "stripeCustomerId" text);

CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

CREATE TABLE "verification_observations" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  outcome TEXT NOT NULL,
  run_id TEXT,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE webhook_deliveries (
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (provider, delivery_id)
);

CREATE INDEX "account_userId_idx" on "account" ("userId");

CREATE UNIQUE INDEX candidate_dispatches_nonce_v3
  ON candidate_dispatches(dispatch_nonce) WHERE dispatch_nonce IS NOT NULL;

CREATE INDEX candidate_dispatches_pending_v3
  ON candidate_dispatches(finalize_after, dispatched_at)
  WHERE pending_at IS NOT NULL AND finalized_at IS NULL AND terminal_reason IS NULL;

CREATE UNIQUE INDEX candidate_dispatches_report_job_v3
  ON candidate_dispatches(report_run_id, report_run_attempt, report_check_run_id)
  WHERE report_check_run_id IS NOT NULL;

CREATE INDEX github_sync_snapshots_installation
  ON github_sync_snapshots (installation_id, created_at);

CREATE INDEX idx_agent_report_events_root_time
  ON agent_report_events(private_root_id, occurred_at, id);

CREATE INDEX idx_agent_report_private_roots_deletion
  ON agent_report_private_roots(delete_at, id);

CREATE INDEX idx_agent_report_private_roots_project
  ON agent_report_private_roots(project_id, id);

CREATE INDEX idx_agent_report_receipts_expiry
  ON agent_report_receipts(expires_at, id);

CREATE UNIQUE INDEX idx_device_keys_fingerprint ON device_keys(fingerprint);

CREATE INDEX idx_device_keys_user ON device_keys(github_user_id);

CREATE INDEX idx_observations_project ON verification_observations(project_id, observed_at);

CREATE INDEX idx_orgs_installation ON organizations(installation_id);

CREATE INDEX idx_policy_bundles_source
  ON policy_bundles(project_id, source_ref, source_sha);

CREATE INDEX idx_principals_ba_user ON principals(better_auth_user_id);

CREATE INDEX idx_proof_verifications_check_run
  ON proof_verifications(check_run_id);

CREATE INDEX idx_proof_verifications_reused_metrics
  ON proof_verifications(project_id, check_run_id, subject_sha, policy_digest);

CREATE INDEX idx_proof_verifications_subject
  ON proof_verifications(project_id, subject_sha, started_at);

CREATE INDEX idx_queue_attestations_chain
  ON queue_attestations(github_repository_id, base_ref, transition_sequence);

CREATE UNIQUE INDEX idx_queue_attestations_one_record_per_attempt
  ON queue_attestations(attempt_id) WHERE transition_sequence IS NOT NULL;

CREATE INDEX "invitation_email_idx" on "invitation" ("email");

CREATE INDEX "invitation_organizationId_idx" on "invitation" ("organizationId");

CREATE INDEX "member_organizationId_idx" on "member" ("organizationId");

CREATE INDEX "member_userId_idx" on "member" ("userId");

CREATE UNIQUE INDEX "organization_slug_uidx" on "organization" ("slug");

CREATE INDEX project_r2_cleanup_intents_due
  ON project_r2_cleanup_intents (state, lease_expires_at, created_at);

CREATE INDEX project_r2_cleanup_intents_project
  ON project_r2_cleanup_intents (project_id, state, lease_expires_at);

CREATE UNIQUE INDEX project_r2_one_active_generation
  ON project_r2_capability_generations (state) WHERE state = 'active';

CREATE INDEX project_release_jobs_organization
  ON project_release_jobs (organization_id, started_at);

CREATE INDEX project_release_queue_refs_repository
  ON project_release_queue_refs (github_repository_id, project_id, base_ref);

CREATE INDEX project_write_leases_expiry
  ON project_write_leases (github_repository_id, expires_at);

CREATE UNIQUE INDEX queue_assignments_one_per_attempt ON queue_assignments (attempt_id);

CREATE INDEX queue_assignments_repository ON queue_assignments (github_repository_id, base_ref);

CREATE INDEX queue_entries_by_repo ON queue_entries_index (github_repository_id, base_ref, state);

CREATE INDEX queue_runners_repo_principal ON queue_runners (github_repository_id, principal_id);

CREATE INDEX queue_transitions_by_repo
  ON queue_transitions_index (github_repository_id, base_ref, transition_sequence);

CREATE INDEX "session_userId_idx" on "session" ("userId");

CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");

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

CREATE TRIGGER agent_report_private_root_is_immutable
BEFORE UPDATE ON agent_report_private_roots
BEGIN
  SELECT RAISE(ABORT, 'private feedback root identity is immutable');
END;

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

CREATE TRIGGER agent_report_provenance_is_immutable
BEFORE UPDATE ON agent_report_provenance
BEGIN
  SELECT RAISE(ABORT, 'private feedback provenance is immutable');
END;

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

CREATE TRIGGER project_membership_guards_queue_assignments
BEFORE INSERT ON queue_assignments WHEN
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

CREATE TRIGGER project_membership_guards_queue_projects
BEFORE INSERT ON queue_projects WHEN
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

CREATE TRIGGER project_membership_guards_queue_state
BEFORE INSERT ON queue_state WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.id = NEW.project_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id AND l.project_id = NEW.project_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER project_membership_guards_queue_status_comments
BEFORE INSERT ON queue_status_comments WHEN
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

CREATE TRIGGER project_membership_guards_team_repos
BEFORE INSERT ON team_repos WHEN
  NOT EXISTS (SELECT 1 FROM projects p WHERE p.github_repository_id = NEW.github_repository_id AND p.organization_id = NEW.organization_id)
  OR (EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = NEW.github_repository_id)
      AND NOT EXISTS (SELECT 1 FROM project_write_leases l WHERE l.github_repository_id = NEW.github_repository_id))
  OR EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = NEW.github_repository_id)
BEGIN SELECT RAISE(IGNORE); END;

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

CREATE TRIGGER queue_projects_blocks_verifier_protocol_downgrade
BEFORE UPDATE OF verifier_protocol ON queue_projects
WHEN OLD.verifier_protocol = 3 AND NEW.verifier_protocol <> 3
BEGIN
  SELECT RAISE(ABORT, 'verifier protocol downgrade blocked');
END;

-- Generic singleton and readiness state required by a new control plane.
INSERT INTO project_r2_capability_generations (generation, state)
VALUES ('phase-1-existing-bucket', 'active');

INSERT INTO project_lifecycle_rollout
  (id, maintenance_mode, destructive_schema_ready_at)
VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT INTO queue_clock (id, started_at, finished_at, source)
VALUES ('tick', '1970-01-01T00:00:00.000Z', NULL, 'none');

INSERT INTO agent_report_retention_clock (id) VALUES (1);
