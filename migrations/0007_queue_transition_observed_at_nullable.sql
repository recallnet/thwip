-- DEPLOY ORDER: before-worker
-- A projected transition may not know when it was observed.
--
-- The Durable Object only began recording the observation time of a transition
-- after the first few had already been written, and the projection was filling
-- observed_at with the time the projection ran. That reported when this code
-- executed rather than when the base moved, so the column now admits null and
-- the projection passes through what the object actually knows.
--
-- The table is rebuilt rather than altered because SQLite cannot drop a NOT NULL
-- constraint in place. It is a derived read model: rebuilding loses nothing that
-- is not re-derivable from the object, which is the authority.

DROP TABLE IF EXISTS queue_transitions_index;

CREATE TABLE queue_transitions_index (
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
  observed_at TEXT,
  UNIQUE (github_repository_id, base_ref, queue_epoch, transition_sequence)
);

CREATE INDEX IF NOT EXISTS queue_transitions_by_repo ON queue_transitions_index (github_repository_id, base_ref, transition_sequence);

-- Forget how far the projection had advanced, so the next mutation re-projects
-- the whole chain with its real kinds and prior digests instead of leaving the
-- rows written by the version that hardcoded them.
DELETE FROM queue_projection_marks;
