-- The projection needs each entry's head commit.
--
-- A check can be answered from the projection when it is plainly not this pull
-- request's turn, which costs no Durable Object request. That is only safe if the
-- projection can tell the check is asking about the same commit the entry was
-- recorded at. Without the head sha it cannot, and answering about a different
-- commit is worse than not answering.
ALTER TABLE queue_entries_index ADD COLUMN head_sha TEXT;
