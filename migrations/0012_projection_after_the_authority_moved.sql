-- Let the projection accept writes from the queue's new home.
--
-- The projection refuses a message whose generation it has already seen, which
-- is what stops an out-of-order write moving it backwards. The generation is a
-- per-queue counter, and moving the authority from the Durable Object to D1
-- started a fresh document at generation 1 while the marks still held the
-- object's last, in the hundreds. Every write from the new authority was
-- therefore discarded as stale, and the projection froze on the object's final
-- state: the dashboard showed a lane holder that had already merged, and the
-- fast decline path answered from it.
--
-- Clearing the marks makes the next write land and re-project everything. The
-- entries index goes with them because it is keyed by entry rather than by
-- generation, so a row for a pull request the new document has never heard of
-- would otherwise sit there forever with whatever state the object last gave it.
--
-- Both tables are derived. Nothing here is the only copy of anything: the queue
-- document is the authority and re-projects in full on its next mutation.
DELETE FROM queue_projection_marks;
DELETE FROM queue_entries_index;
