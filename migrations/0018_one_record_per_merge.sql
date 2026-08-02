-- DEPLOY ORDER: after-worker
--
-- The one migration in this directory that goes after the Worker that ships
-- with it. The unique index below refuses the second record for a merge, and a
-- recording path that does not expect that refusal turns it into a failed
-- merge. Deploy the Worker that catches the constraint, then apply this.
--
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
-- This resolves per attempt_id, which is what the index below constrains,
-- not per (repository, base ref, sequence). An earlier version of this
-- migration grouped by position and compared against whichever digest
-- `queue_transitions_index` names there: if the index names a digest that
-- belongs to neither duplicate, or has no row at that position at all, that
-- version cleared both rows and the position vanished with nothing left to
-- rewrite it. And two records for one attempt at different sequences — the
-- plain sequential-retry shape — never shared a position, so that version
-- left them both standing and the unique index below failed to create.
--
-- The rule now, for every attempt_id with more than one row still holding a
-- transition_sequence: keep exactly one, and clear transition_sequence on
-- the rest.
--
--   1. the row whose digest is the one `queue_transitions_index` recorded,
--      if exactly one of the attempt's rows matches — that table is the
--      projection of the Durable Object's authority, not a guess;
--   2. otherwise the row with the earliest created_at, breaking any
--      remaining tie by digest so the choice is deterministic rather than
--      whatever order SQLite happens to return.
--
-- A row with a null transition_sequence is a merge intent, not a chain
-- link, and is never touched — an attempt is free to have signed one of
-- those alongside its record.
WITH duplicated_attempts AS (
  SELECT attempt_id
    FROM queue_attestations
   WHERE transition_sequence IS NOT NULL
   GROUP BY attempt_id
  HAVING COUNT(*) > 1
),
indexed_rows AS (
  SELECT qa.attempt_id, qa.digest
    FROM queue_attestations AS qa
    JOIN duplicated_attempts AS d ON d.attempt_id = qa.attempt_id
   WHERE qa.transition_sequence IS NOT NULL
     AND qa.digest IN (SELECT digest FROM queue_transitions_index)
),
indexed_counts AS (
  SELECT attempt_id, COUNT(*) AS indexed_count
    FROM indexed_rows
   GROUP BY attempt_id
),
keepers AS (
  SELECT d.attempt_id,
         COALESCE(
           (SELECT ir.digest
              FROM indexed_rows AS ir
              JOIN indexed_counts AS ic ON ic.attempt_id = ir.attempt_id
             WHERE ir.attempt_id = d.attempt_id
               AND ic.indexed_count = 1),
           (SELECT qa.digest
              FROM queue_attestations AS qa
             WHERE qa.attempt_id = d.attempt_id
               AND qa.transition_sequence IS NOT NULL
             ORDER BY qa.created_at ASC, qa.digest ASC
             LIMIT 1)
         ) AS keeper_digest
    FROM duplicated_attempts AS d
)
UPDATE queue_attestations
   SET transition_sequence = NULL
 WHERE transition_sequence IS NOT NULL
   AND attempt_id IN (SELECT attempt_id FROM duplicated_attempts)
   AND NOT EXISTS (
     SELECT 1
       FROM keepers AS k
      WHERE k.attempt_id = queue_attestations.attempt_id
        AND k.keeper_digest = queue_attestations.digest
   );

-- One attempt, one chain position. A partial index rather than a plain one
-- because merge intents also live in this table with transition_sequence
-- null, and those are cited by a record rather than being a link themselves
-- — an attempt is free to have signed one of those alongside its record.
CREATE UNIQUE INDEX idx_queue_attestations_one_record_per_attempt
  ON queue_attestations(attempt_id) WHERE transition_sequence IS NOT NULL;
