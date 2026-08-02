-- DEPLOY ORDER: before-worker
-- The queue's authoritative state, moved out of the Durable Object.
--
-- One row per branch queue, holding the whole document the reducer works on.
-- `generation` is the compare-and-swap token: a writer reads it with the
-- document, and its update only lands if nothing else has written since. A
-- writer that loses the race re-reads and replays rather than overwriting, so
-- two concurrent authorizations cannot both believe they hold the lane.
--
-- Durable Objects were serialising this by being single-threaded. They are also
-- metered per request against a daily cap, which a spinning alarm can spend in
-- two hours, and when it is spent the queue stops answering. Rows are metered by
-- the row and this account uses a couple of percent of them.
CREATE TABLE IF NOT EXISTS queue_state (
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  document TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, base_ref)
);
