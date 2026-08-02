-- DEPLOY ORDER: before-worker
-- Move candidate verdicts and dispatch claims out of the Durable Object.
--
-- Both lived in the object's own SQLite, so the merge workflow woke the
-- coordination object every twenty seconds to ask whether a verdict had arrived.
-- Neither is coordination. A verdict is an immutable record keyed by the tree it
-- judged, and a dispatch claim is a rate limit. Reading them here costs D1 row
-- reads, which are free at our volume, instead of Durable Object requests, which
-- are the thing with a daily cliff.

CREATE TABLE IF NOT EXISTS candidate_verdicts (
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
  -- Keyed by tree, so a verdict is about code rather than about an attempt, and
  -- stays true if the attempt is superseded and the same tree comes back.
  PRIMARY KEY (github_repository_id, base_ref, candidate_tree_oid)
);

CREATE TABLE IF NOT EXISTS candidate_dispatches (
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  candidate_tree_oid TEXT NOT NULL,
  dispatched_at TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, base_ref, candidate_tree_oid)
);
