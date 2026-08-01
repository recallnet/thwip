-- Two racing merge runs each signed their own record for one merge, so the
-- chain carried two links claiming one position (sequence 47). Recording
-- looked for an existing record before signing, which narrows that window
-- but does not close it: two truly simultaneous first reports can both read
-- nothing and both sign. The database has to refuse the second write itself.
--
-- Before that constraint can be added, the duplicate already on this chain
-- has to be resolved without destroying evidence. Both rows are signed
-- records, and deleting either one would destroy evidence that a merge run
-- produced it. Instead, the row that lost the race is demoted: its position
-- is cleared so it stops occupying a chain link while its bytes and
-- signature survive for anyone auditing what happened.
--
-- The real link at a given (repository, base ref, sequence) is whichever
-- digest `queue_transitions_index` recorded there — that table is the
-- projection of the Durable Object's authority, not a guess. A row is only
-- demoted when it shares its position with another row and is not the one
-- the index names, so a record written just before its transition made it
-- into the index (a legitimate, temporarily-unindexed state) is left alone.
UPDATE queue_attestations
   SET transition_sequence = NULL
 WHERE transition_sequence IS NOT NULL
   AND digest NOT IN (
     SELECT digest FROM queue_transitions_index
   )
   AND EXISTS (
     SELECT 1
       FROM queue_attestations AS other
      WHERE other.github_repository_id = queue_attestations.github_repository_id
        AND other.base_ref = queue_attestations.base_ref
        AND other.transition_sequence = queue_attestations.transition_sequence
        AND other.digest <> queue_attestations.digest
   );

-- One attempt, one chain position. A partial index rather than a plain one
-- because merge intents also live in this table with transition_sequence
-- null, and those are cited by a record rather than being a link themselves
-- — an attempt is free to have signed one of those alongside its record.
CREATE UNIQUE INDEX idx_queue_attestations_one_record_per_attempt
  ON queue_attestations(attempt_id) WHERE transition_sequence IS NOT NULL;
