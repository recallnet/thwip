-- DEPLOY ORDER: before-worker
-- A missed-webhook repair must close the status conversation before ordinary
-- historical formatting drift. The marker is projected from queue authority;
-- it is not inferred from D1 age or comment text.
ALTER TABLE queue_entries_index
ADD COLUMN terminal_comment_priority INTEGER NOT NULL DEFAULT 0;

-- Values are deliberately durable across projection replay:
--   0 = ordinary terminal history
--   1 = authoritative reconciliation still needs comment acknowledgement
--   2 = GitHub refused the terminal comment, so the no-op is acknowledged and
--       later projection replay cannot restore priority
