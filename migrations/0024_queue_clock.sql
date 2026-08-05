-- DEPLOY ORDER: before-worker
--
-- When a tick last started, and when one last finished.
--
-- The queue already records when it last moved, in
-- `queue_projection_marks.projected_at`, and that mark only moves when the queue
-- does. An idle queue and a queue whose clock has stopped write the same thing,
-- which is nothing. On 5 August Cloudflare stopped dispatching the five minute
-- trigger at 03:55Z with the schedule still listed by its own API, and eleven
-- hours passed before a person comparing invocation counts against
-- `webhook_deliveries` by hand worked out what had happened.
--
-- `started_at` is what the claim compares and swaps, so two clocks cannot tick
-- one lane at once and a tick that throws cannot be retried in a loop by the
-- next request through the door. `finished_at` is what liveness is read from: a
-- tick that starts every five minutes and dies every time is a stopped clock,
-- and reporting it as a working one is the failure this row exists to end.
CREATE TABLE IF NOT EXISTS queue_clock (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  -- 'cron' or 'traffic', so the tail says which clock is carrying the queue.
  source TEXT NOT NULL
);

INSERT OR IGNORE INTO queue_clock (id, started_at, finished_at, source)
VALUES ('tick', '1970-01-01T00:00:00.000Z', NULL, 'none');
