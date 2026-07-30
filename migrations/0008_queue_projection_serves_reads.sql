-- Let the projection answer a dashboard read on its own.
--
-- The projection was built so organization-wide reads never have to touch a
-- Durable Object, and then the dashboard read the object anyway, on a ten second
-- timer, twice per project per poll. One open browser tab was enough to spend the
-- Durable Objects free tier for the month.
--
-- It could not have served those reads before this: it stored enough to list
-- entries but not enough to say whether one was schedulable, nor anything about
-- the branch as a whole. These columns close that gap.

ALTER TABLE queue_entries_index ADD COLUMN scheduler_eligible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_entries_index ADD COLUMN cooldown_until TEXT;
ALTER TABLE queue_entries_index ADD COLUMN last_attempt_id TEXT;

-- Per branch rather than per entry: whether the lane is held, whether the queue
-- is paused, and where the branch is now.
ALTER TABLE queue_projection_marks ADD COLUMN active_attempt_id TEXT;
ALTER TABLE queue_projection_marks ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_projection_marks ADD COLUMN pause_reason TEXT;
ALTER TABLE queue_projection_marks ADD COLUMN rebaseline_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_projection_marks ADD COLUMN base_sha TEXT;
ALTER TABLE queue_projection_marks ADD COLUMN queue_epoch INTEGER NOT NULL DEFAULT 0;

-- Forget how far the projection has advanced, so the next mutation refills every
-- column above rather than leaving them at their defaults.
DELETE FROM queue_projection_marks;
