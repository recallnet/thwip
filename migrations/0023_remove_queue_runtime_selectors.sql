-- DEPLOY ORDER: after-worker
-- Queue setup has one configuration: the installed App owns the queue and
-- writes merge commits. Remove old runtime selectors after the Worker no
-- longer reads them.

ALTER TABLE queue_projects DROP COLUMN merge_writer;
ALTER TABLE queue_projects DROP COLUMN backend;
ALTER TABLE queue_projects DROP COLUMN merge_method;
