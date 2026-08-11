-- DEPLOY ORDER: before-worker
-- Measurements from accepted signed proofs.
--
-- These values stay on the verification that established them. The row already
-- binds the check run, subject commit, active policy, project and verifier
-- version, so copying those identifiers into a second table would create two
-- records that could disagree.
--
-- Null means this verification predates measurement, did not pass, or carried
-- a duration that could not be stored safely. Existing proofs and verification
-- rows remain valid.
ALTER TABLE proof_verifications ADD COLUMN signed_suite_duration_ms INTEGER;
ALTER TABLE proof_verifications ADD COLUMN signed_wall_clock_duration_ms INTEGER;
ALTER TABLE proof_verifications ADD COLUMN verification_duration_ms INTEGER;

-- A reused-proof transition cites its proof check run. This index keeps the
-- aggregate join bounded without changing the compatibility of older rows.
CREATE INDEX idx_proof_verifications_reused_metrics
  ON proof_verifications(project_id, check_run_id, subject_sha, policy_digest);

CREATE INDEX idx_queue_attestations_reused_metrics
  ON queue_attestations(kind, github_repository_id, transition_sequence)
  WHERE transition_sequence IS NOT NULL;
