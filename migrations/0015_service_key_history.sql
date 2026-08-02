-- DEPLOY ORDER: before-worker
-- migrations/0015_service_key_history.sql
-- Every key the service has ever signed with.
--
-- The chain is permanent and its records are signed. Rotating the signing key
-- without keeping the old public half would make every record signed before the
-- rotation unverifiable, which is indistinguishable from those records being
-- forged. So keys are retired, never removed.
CREATE TABLE service_keys (
  kid TEXT PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Set when the key stops signing. It still verifies everything it signed.
  retired_at TEXT
);

-- Where a branch's real records begin.
--
-- Links below this number are merge commit ids padded with zeroes, written
-- before records existed. A verifier must report them as pre-attestation rather
-- than as broken signatures, and it can only tell the difference if the boundary
-- is recorded.
ALTER TABLE queue_projects ADD COLUMN attested_from_sequence INTEGER NOT NULL DEFAULT 0;
