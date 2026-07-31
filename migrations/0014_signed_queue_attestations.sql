-- The queue's signed records, kept by the digest that names them.
--
-- Until now a chain link was the merge commit id padded out to look like a
-- digest. Nothing was signed and nothing was stored, so the chain recorded that
-- a merge happened without attesting to anything about it. These are the bytes
-- the queue actually signed, so a reader can verify a link instead of trusting
-- the projection that reports it.
--
-- The digest is the primary key because it is the identity: it is computed over
-- exactly these bytes, and re-serialising the record would produce a different
-- one. `bytes` is the canonical JSON that was signed, stored verbatim.
CREATE TABLE queue_attestations (
  digest TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  -- Set for transition records, which occupy a position in the chain. A merge
  -- intent has none; it is cited by the record rather than being a link.
  transition_sequence INTEGER,
  attempt_id TEXT,
  bytes TEXT NOT NULL,
  jws TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Walking one branch's chain in order, which is how a reader verifies it.
CREATE INDEX idx_queue_attestations_chain
  ON queue_attestations(github_repository_id, base_ref, transition_sequence);
