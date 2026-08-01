-- Who is connected to run a queue's turns on their own machine (plan.md §5.0).
--
-- A row means a runner said it was here at that moment, nothing more: it is
-- liveness, not a claim and not a lease. The Durable Object that would have
-- held this as a WebSocket was retired to D1 to stay inside the free tier's
-- daily request cap, and D1 cannot hold a socket, so a heartbeat row is the
-- whole mechanism.
--
-- The key is all three columns, not just repository and principal. One person
-- may run two machines against the same repository at once, and one machine
-- (one device key) may serve two repositories. Losing either column would
-- make one heartbeat evict the other's row instead of living beside it.
CREATE TABLE IF NOT EXISTS queue_runners (
  github_repository_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  device_key_id TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, principal_id, device_key_id)
);

CREATE INDEX IF NOT EXISTS queue_runners_repo_principal
  ON queue_runners (github_repository_id, principal_id);
