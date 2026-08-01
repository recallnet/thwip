-- What the queue dispatched to a developer's own machine, and what came back
-- (plan.md 19.3, 21.1).
--
-- Under fresh and audited the integration runs on the device, so the merge gate
-- has nothing to read unless the dispatch and the answer are written down. This
-- table is what it reads. A merge under either profile is refused when there is
-- no row here for the attempt, or the row carries no accepted receipt, or the
-- receipt is about another tree or another device.
--
-- DEPLOY ORDER: this migration goes before the Worker that reads it, like 0015,
-- 0017, 0019 and 0020. 0018 is the one exception in this directory and it goes
-- after its Worker, for the reason its own header gives. A Worker deployed
-- ahead of this file would throw on every claim instead of refusing one.
--
-- The receipt lives in the same row as the assignment rather than in a table of
-- its own, because a receipt with no assignment is not a thing the system has a
-- use for. It cannot be inserted alone, and the update that fills it in matches
-- on receipt_digest IS NULL, so the first accepted receipt is the only one.
CREATE TABLE IF NOT EXISTS queue_assignments (
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
  receipt_accepted_at TEXT
);

-- One assignment per attempt, which is what the reducer already says: an
-- attempt's assignment is immutable once issued. Two devices racing the same
-- offer means one of them loses here rather than both running and one of the
-- two receipts deciding the merge.
CREATE UNIQUE INDEX IF NOT EXISTS queue_assignments_one_per_attempt
  ON queue_assignments (attempt_id);

CREATE INDEX IF NOT EXISTS queue_assignments_repository
  ON queue_assignments (github_repository_id, base_ref);
