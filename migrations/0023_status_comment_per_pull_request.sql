-- DEPLOY ORDER: before-worker
--
-- Which comment on a pull request is thwip's, and what it currently says.
--
-- The App keeps one comment per queued pull request and edits it in place.
-- Finding that comment again needs its id, and every alternative to storing the
-- id is a listing of the pull request's comments on every write, which is a
-- GitHub call spent on a question that has one stable answer.
--
-- `fingerprint` is a hash of what the comment says, taken over everything
-- except the clock. A tick where nothing moved compares it and writes nothing,
-- so an idle queue costs zero comment writes. It is recorded only after GitHub
-- has accepted the write: a fingerprint stored ahead of a failed write would
-- convince every later attempt there was nothing to say, and leave the old
-- answer on the page reading as current.
--
-- Keyed by branch as well as by pull request, because a repository can queue
-- more than one branch and a pull request belongs to exactly one of them.
CREATE TABLE IF NOT EXISTS queue_status_comments (
  github_repository_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL,
  -- Null until GitHub has told us the id of the comment it created.
  comment_id INTEGER,
  fingerprint TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (github_repository_id, base_ref, pull_request_number)
);
