-- DEPLOY ORDER: before-worker
-- The generation each branch's projection was last advanced to. Projection
-- messages arrive at-least-once and unordered, so a write from an older
-- generation is dropped rather than applied: otherwise a retried old message
-- would overwrite newer truth and stay wrong until the next change.
CREATE TABLE IF NOT EXISTS queue_projection_marks (
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  projected_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (github_repository_id, base_ref)
);
